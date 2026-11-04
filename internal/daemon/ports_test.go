package daemon

import (
	"net"
	"strings"
	"testing"
)

func TestPortsMapHostPortsToMachinesAndServices(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	m, err := d.c.Up(Up{Template: "t", Name: "web", Ports: []string{"0:8000", "0:9000"}})
	if err != nil {
		t.Fatal(err)
	}
	free := freePort(t)
	if _, err := d.c.AddService(Service{Name: "api", Template: "t", Ports: []Port{{IP: "127.0.0.1", Host: free, Guest: 8080}}, Max: 1}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveService("api")

	ps, err := d.c.Ports()
	if err != nil || len(ps) != 3 {
		t.Fatalf("%+v %v", ps, err)
	}
	byHost := map[int]PortMapping{}
	for i, p := range ps {
		byHost[p.Host] = p
		if i > 0 && ps[i-1].Host > p.Host {
			t.Error("not by host port")
		}
	}
	for _, mp := range m.Ports {
		got := byHost[mp.Host]
		if got.Kind != "machine" || got.Name != "web" || got.Template != "t" || got.Guest != mp.Guest || !got.Open {
			t.Errorf("machine port %d: %+v", mp.Host, got)
		}
	}
	svc := byHost[free]
	if svc.Kind != "service" || svc.Name != "api" || svc.Guest != 8080 || !svc.Open || svc.Replicas != 0 {
		t.Errorf("service port: %+v", svc)
	}
	if !strings.Contains(svc.Describe(), "at zero") || !strings.Contains(byHost[m.Ports[0].Host].Describe(), "→ machine web:8000") {
		t.Errorf("described: %s / %s", svc.Describe(), byHost[m.Ports[0].Host].Describe())
	}

	// Checks: the fleet's, another program's, a free one
	if c, _ := d.c.CheckPort("", m.Ports[0].Host); c.Free || c.By != "machine web" {
		t.Errorf("a machine's port: %+v", c)
	}
	if c, _ := d.c.CheckPort("0.0.0.0", free); c.Free || c.By != "service api" {
		t.Errorf("a service's, on every address: %+v", c)
	}
	other, _ := net.Listen("tcp", "127.0.0.1:0")
	defer other.Close()
	op := other.Addr().(*net.TCPAddr).Port
	if c, _ := d.c.CheckPort("127.0.0.1", op); c.Free || c.By != "another program" || c.Detail == "" {
		t.Errorf("another program's: %+v", c)
	}
	if c, _ := d.c.CheckPort("", freePort(t)); !c.Free || c.By != "" {
		t.Errorf("a free one: %+v", c)
	}
	for _, bad := range []string{"port=0", "port=70000", "port=x", "port=80&ip=nope"} {
		resp, _ := d.c.http.Get(d.c.base + "/v1/ports/check?" + bad)
		if resp.StatusCode != 400 {
			t.Errorf("%s: %d", bad, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
