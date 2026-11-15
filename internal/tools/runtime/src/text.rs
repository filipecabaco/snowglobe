//! Terminal output clean-ups (the same ones the page and the CLI rely on).

use std::sync::LazyLock;

use regex::bytes::Regex;

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]|\r").unwrap());
static QUERIES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9]*n|\x1b\[[>=]?[0-9]*c").unwrap());
static PROGRESS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)=PROGRESS REPORT====.*?\r?\n\r?\n").unwrap());

/// Text without terminal control sequences, for a pipe or a comparison.
pub fn plain(b: &[u8]) -> Vec<u8> {
    CONTROL.replace_all(b, &b""[..]).into_owned()
}

/// What a terminal shows, line by line, of what a program printed to it: a line it redrew as it was
/// edited (a REPL's, after every key: back to its start, the prompt and the line again, then erase
/// what is left) is the line it ended as, not every one it drew on the way. Carriage return,
/// backspace, cursor left and right (and to a column) and erase in line are followed; colours,
/// other sequences and moves up or down are dropped, as `plain` drops them.
pub fn rendered(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut col = 0usize;
    let put = |line: &mut Vec<u8>, col: &mut usize, c: u8| {
        if *col < line.len() {
            line[*col] = c;
        } else {
            line.resize(*col, b' ');
            line.push(c);
        }
        *col += 1;
    };
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            0x1b if b.get(i + 1) == Some(&b'[') => {
                // CSI: parameters, then the final byte
                let mut j = i + 2;
                while j < b.len() && !(0x40..=0x7e).contains(&b[j]) {
                    j += 1;
                }
                let params = std::str::from_utf8(&b[i + 2..j.min(b.len())]).unwrap_or("");
                let n = params.split(';').next().and_then(|p| p.trim_start_matches('?').parse::<usize>().ok());
                match b.get(j) {
                    Some(b'K') => match n.unwrap_or(0) {
                        0 => line.truncate(col),
                        1 => {
                            let upto = col.min(line.len());
                            line[..upto].fill(b' ')
                        },
                        _ => line.clear(),
                    },
                    Some(b'D') => col = col.saturating_sub(n.unwrap_or(1).max(1)),
                    Some(b'C') => col += n.unwrap_or(1).max(1),
                    Some(b'G') => col = n.unwrap_or(1).max(1) - 1,
                    _ => {},
                }
                i = j + 1;
                continue;
            },
            0x1b if b.get(i + 1) == Some(&b']') => {
                // OSC, to BEL or ST
                let mut j = i + 2;
                while j < b.len() && b[j] != 0x07 && !(b[j] == 0x1b && b.get(j + 1) == Some(&b'\\')) {
                    j += 1;
                }
                i = if b.get(j) == Some(&0x07) { j + 1 } else { j + 2 };
                continue;
            },
            // ESC and one byte (ESC =, ESC >), or a character set (ESC ( B): dropped
            0x1b => {
                i += if matches!(b.get(i + 1), Some(b'(' | b')')) { 3 } else { 2 };
                continue;
            },
            b'\r' => col = 0,
            b'\n' => {
                out.extend_from_slice(&line);
                out.push(b'\n');
                line.clear();
                col = 0;
            },
            0x08 => col = col.saturating_sub(1),
            b'\t' => put(&mut line, &mut col, b'\t'),
            c if c < 0x20 || c == 0x7f => {},
            c => put(&mut line, &mut col, c),
        }
        i += 1;
    }
    out.extend_from_slice(&line);
    out
}

/// Terminal queries (cursor position, device attributes) were asked of a terminal that no longer
/// exists; replayed, xterm.js would answer them and the answer would reach the app as typed input.
pub fn without_queries(b: &[u8]) -> Vec<u8> {
    QUERIES.replace_all(b, &b""[..]).into_owned()
}

/// On the slow emulated boot, an OTP "application started" progress report can slip out before
/// Elixir's Logger installs the filter that normally hides it. It's noise on the replayed screen.
pub fn without_progress_reports(b: &[u8]) -> Vec<u8> {
    PROGRESS.replace_all(b, &b""[..]).into_owned()
}

fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// What the terminal shows now: everything after the last "clear screen" sequence.
pub fn since_last_clear(b: &[u8]) -> &[u8] {
    let mut start = 0;
    // ESC[2J is the usual clear; BusyBox's `clear` homes the cursor and erases down instead
    for seq in [&b"\x1b[2J"[..], b"\x1b[H\x1b[J", b"\x1bc"] {
        if let Some(at) = rfind(b, seq) {
            start = start.max(at + seq.len());
        }
    }
    &b[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans() {
        assert_eq!(plain(b"\x1b[1;34mhi\x1b[m\r\n"), b"hi\n");
        assert_eq!(without_queries(b"a\x1b[6nb\x1b[>0cc"), b"abc");
        assert_eq!(since_last_clear(b"old\x1b[2Jnew"), b"new");
        // A REPL redrawing its line at each key: the line it ended as
        assert_eq!(rendered(b">>> p\r\x1b[K>>> pr\r\x1b[K>>> print(6*7)\r\n42\r\n>>> "), b">>> print(6*7)\n42\n>>> ");
        assert_eq!(rendered(b"abc\x1b[2Dz\x1b[K\n"), b"az\n");
        assert_eq!(rendered(b"\x1b[1;34mhi\x1b[m\x1b]0;title\x07!\x1b>\x1b(B\n"), b"hi!\n");
        assert_eq!(since_last_clear(b"old\x1b[H\x1b[Jnew"), b"new");
        assert_eq!(
            without_progress_reports(b"a=PROGRESS REPORT==== x\r\n  y\r\n\r\nb"),
            b"ab"
        );
    }
}
