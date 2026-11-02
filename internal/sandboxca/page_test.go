package sandboxca

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The page signs a leaf for each host from tls.json alone: one made that way must verify against
// the certificate the guest trusts, whatever date the guest's clock says.
func TestALeafSignedFromThePageVerifies(t *testing.T) {
	ca, err := New()
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "tls.json")
	if err := ca.WritePage(file); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(file)
	var page Page
	if err := json.Unmarshal(data, &page); err != nil {
		t.Fatal(err)
	}

	caKey, err := x509.ParsePKCS8PrivateKey(page.CAKey)
	if err != nil {
		t.Fatal(err)
	}
	leafPub, err := x509.ParsePKIXPublicKey(page.LeafSPKI)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(ca.CertPEM)
	caCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber:   big.NewInt(2),
		Subject:        pkix.Name{CommonName: "example.com"},
		DNSNames:       []string{"example.com"},
		NotBefore:      time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:       time.Date(2049, 12, 31, 0, 0, 0, 0, time.UTC),
		AuthorityKeyId: page.CAKeyID,
		ExtKeyUsage:    []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, leafPub, caKey.(crypto.Signer))
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca.CertPEM)
	for _, now := range []time.Time{time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2048, 1, 1, 0, 0, 0, 0, time.UTC)} {
		if _, err := cert.Verify(x509.VerifyOptions{DNSName: "example.com", Roots: roots, CurrentTime: now}); err != nil {
			t.Errorf("%d: %v", now.Year(), err)
		}
	}
	// The issuer the page writes into each leaf
	if !bytes.Equal(cert.RawIssuer, page.CASubject) {
		t.Error("the page's issuer isn't the CA's subject")
	}
}

func TestWritePageFails(t *testing.T) {
	ca, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WritePage(filepath.Join(t.TempDir(), "missing", "tls.json")); err == nil {
		t.Error("wrote into a directory that isn't there")
	}
}
