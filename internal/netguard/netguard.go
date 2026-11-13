// Package netguard keeps a connection made for someone else on the public internet: a URL a
// remote client gave the daemon, or a token endpoint a downloaded site names, can't reach this
// host's loopback, its private network or a cloud's metadata service. The check is made on the
// address connected to, after DNS, so a name that resolves (or re-resolves) to a private address
// and a redirect to one are refused as well.
package netguard

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// Public says whether ip is an address on the public internet: not loopback, private (RFC 1918,
// unique local), link local (cloud metadata at 169.254.169.254), CGNAT, multicast or unspecified.
func Public(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range nonPublic {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// Ranges Public refuses that netip has no predicate for
var nonPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),      // this network
	netip.MustParsePrefix("100.64.0.0/10"),  // CGNAT, and some clouds' internal addresses
	netip.MustParsePrefix("192.0.0.0/24"),   // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"),  // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),    // reserved, broadcast
	netip.MustParsePrefix("64:ff9b::/96"),   // NAT64: an IPv4 address inside
	netip.MustParsePrefix("64:ff9b:1::/48"), // local NAT64
	netip.MustParsePrefix("2002::/16"),      // 6to4: an IPv4 address inside
	netip.MustParsePrefix("100::/64"),       // discard
	netip.MustParsePrefix("2001:db8::/32"),  // documentation
	netip.MustParsePrefix("fec0::/10"),      // site local (deprecated)
	netip.MustParsePrefix("2001::/32"),      // Teredo: an IPv4 address inside
	netip.MustParsePrefix("2001:10::/28"),   // ORCHID
	netip.MustParsePrefix("2001:20::/28"),   // ORCHIDv2
}

// Control is a net.Dialer's Control that refuses a connection to an address that isn't Public.
func Control(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("%s: %w", address, err)
	}
	if !Public(ap.Addr()) {
		return fmt.Errorf("%s isn't a public address: a URL from elsewhere may not reach this host's own or private network", ap.Addr())
	}
	return nil
}

// Client is an HTTP client that connects to public addresses only (through no proxy: a proxy
// would make the connection for it), with timeout on the whole request when it isn't 0.
func Client(timeout time.Duration) *http.Client {
	d := &net.Dialer{Timeout: 15 * time.Second, Control: Control}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return d.DialContext(ctx, network, addr)
			},
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			MaxIdleConnsPerHost:   4,
		},
	}
}
