package daemon

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A daemon serving its TCP API on loopback, and a client of it as another host would be
func remoteDaemon(t *testing.T, policy Policy) (*daemonUnderTest, *Client) {
	t.Helper()
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	d := startDaemon(t, shortTemp(t), Options{Listen: addr, Token: "0123456789abcdef", Remote: policy})
	waitFor(t, func() bool {
		c, err := net.Dial("tcp", addr)
		if err == nil {
			c.Close()
		}
		return err == nil
	})
	c, err := NewClient("http://"+addr, "0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	return d, c
}

func TestARemoteRequestNamesNoPathOfThisHost(t *testing.T) {
	site := fakeSite(t)
	d, c := remoteDaemon(t, Policy{})
	defer d.stop(t)
	// The path itself: refused, without saying whether it is there
	for _, p := range []string{site, "/etc", filepath.Join(site, "nope")} {
		err := c.call("POST", "/v1/templates", AddTemplate{Site: p, Name: "direct"}, nil)
		if statusOf(err) != 403 || !strings.Contains(err.Error(), "--site-root") {
			t.Errorf("a remote template of %s: %v", p, err)
		}
	}
	// The client uploads it instead, and the daemon keeps it under its own directory
	tm, err := c.AddTemplate(AddTemplate{Site: site, Name: "up"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tm.Site, filepath.Join(d.dir, "sites")+"/") {
		t.Errorf("the template's site is %s, not an upload", tm.Site)
	}
	if _, err := os.Stat(filepath.Join(tm.Site, "run.json")); err != nil {
		t.Error(err)
	}
	// Removed, and old enough, its upload goes with it
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(tm.Site, old, old)
	if err := c.RemoveTemplate("up"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tm.Site); !os.IsNotExist(err) {
		t.Errorf("the upload of a removed template is still there: %v", err)
	}
	// The same request on the Unix socket names the path, as this host's user may
	if _, err := d.c.AddTemplate(AddTemplate{Site: site, Name: "local"}); err != nil {
		t.Errorf("a local template: %v", err)
	}
}

func TestASiteRootLetsARemoteRequestNameAPath(t *testing.T) {
	site := fakeSite(t)
	d, c := remoteDaemon(t, Policy{SiteRoots: []string{filepath.Dir(site)}})
	defer d.stop(t)
	if err := c.call("POST", "/v1/templates", AddTemplate{Site: site, Name: "rooted"}, nil); err != nil {
		t.Errorf("a site under a root: %v", err)
	}
	// A link out of the root is followed, and refused
	link := filepath.Join(filepath.Dir(site), "out")
	os.Symlink(t.TempDir(), link)
	if err := c.call("POST", "/v1/templates", AddTemplate{Site: link, Name: "out"}, nil); statusOf(err) != 403 {
		t.Errorf("a link out of the root: %v", err)
	}
	// So is a build's source
	err := c.call("POST", "/v1/builds", BuildRequest{Source: "/etc", Name: "b"}, nil)
	if statusOf(err) != 403 {
		t.Errorf("a remote build of /etc: %v", err)
	}
}

func TestARemoteRequestGetsNoPrivateNetwork(t *testing.T) {
	site := fakeSite(t)
	d, c := remoteDaemon(t, Policy{})
	defer d.stop(t)
	for _, req := range []AddTemplate{{Site: site, AllowPrivate: true}, {Site: site, Egress: "private"}} {
		if _, err := c.AddTemplate(req); statusOf(err) != 403 {
			t.Errorf("a remote %+v: %v", req, err)
		}
	}
	// A URL on this host: not fetched
	srv := httptest.NewServer(http.FileServer(http.Dir(site)))
	defer srv.Close()
	_, err := c.AddTemplate(AddTemplate{Site: srv.URL + "/", Name: "ssrf"})
	if err == nil || !strings.Contains(err.Error(), "isn't a public address") {
		t.Errorf("a remote template of a loopback URL: %v", err)
	}
}

func TestRemotePrivateAllowsIt(t *testing.T) {
	site := fakeSite(t)
	d, c := remoteDaemon(t, Policy{Private: true})
	defer d.stop(t)
	if _, err := c.AddTemplate(AddTemplate{Site: site, Name: "p", AllowPrivate: true}); err != nil {
		t.Errorf("--remote-allow-private: %v", err)
	}
}

func TestTheTCPAPIOnAnotherHostNeedsTLS(t *testing.T) {
	s, _ := New(Options{Dir: shortTemp(t), Listen: "0.0.0.0:0", Token: "0123456789abcdef", Logf: t.Logf})
	if err := s.Serve(context.Background()); err == nil || !strings.Contains(err.Error(), "TLS") {
		t.Errorf("--listen 0.0.0.0 in the clear: %v", err)
	}
	s, _ = New(Options{Dir: shortTemp(t), Listen: "0.0.0.0:0", Token: "0123456789abcdef", TLSCert: "x", Logf: t.Logf})
	if err := s.Serve(context.Background()); err == nil || !strings.Contains(err.Error(), "together") {
		t.Errorf("a certificate without a key: %v", err)
	}
	for addr, want := range map[string]bool{"127.0.0.1:1": true, "[::1]:1": true, "localhost:1": true, "0.0.0.0:1": false, ":1": false, "10.0.0.1:1": false} {
		if loopback(addr) != want {
			t.Errorf("loopback(%s) = %v", addr, !want)
		}
	}
}

func TestTheTCPAPIServesTLS(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	selfSigned(t, cert, key)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	d := startDaemon(t, shortTemp(t), Options{Listen: addr, Token: "0123456789abcdef", TLSCert: cert, TLSKey: key})
	defer d.stop(t)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	var resp *http.Response
	waitFor(t, func() bool {
		var err error
		resp, err = client.Get("https://" + addr + "/v1/health")
		return err == nil
	})
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("over TLS without the token: %s", resp.Status)
	}
	// Plain HTTP gets Go's 400 for an HTTP request to an HTTPS server, never the API
	if resp, err := http.Get("http://" + addr + "/v1/health"); err == nil {
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Errorf("plain HTTP on a TLS listener: %s", resp.Status)
		}
	}
}

func TestAServicesPortWithNoAddressIsLoopback(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	site := fakeSite(t)
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: site, Name: "py"}); err != nil {
		t.Fatal(err)
	}
	svc, err := d.c.AddService(Service{Name: "web", Template: "py", Ports: []Port{{Guest: 8000}}})
	if err != nil {
		t.Fatal(err)
	}
	if svc.Ports[0].IP != "127.0.0.1" {
		t.Errorf("a port with no address listens on %q", svc.Ports[0].IP)
	}
}

func selfSigned(t *testing.T, certPath, keyPath string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "daemon"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalECPrivateKey(k)
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), 0o600)
}
