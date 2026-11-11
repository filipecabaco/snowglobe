//! jtab: render a JSON array of objects as a table, from a file or stdin.
//! Built with clap (arguments), serde_json (parsing) and comfy-table (rendering).

use std::cmp::Ordering;
use std::fs;
use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use clap::Parser;
use comfy_table::{Attribute, Cell, ContentArrangement, Table, presets::UTF8_FULL_CONDENSED};
use serde_json::{Map, Value};

/// Render a JSON array of objects as a table
#[derive(Parser)]
#[command(
    version,
    after_help = "Examples:\n  jtab languages.json --sort year --reverse\n  jtab languages.json --where typing=static --columns name,year\n  echo '[{\"a\":1},{\"a\":2}]' | jtab"
)]
struct Args {
    /// JSON file to read (reads stdin when omitted)
    file: Option<String>,

    /// Sort rows by this column
    #[arg(short, long)]
    sort: Option<String>,

    /// Reverse the sort order
    #[arg(short, long, requires = "sort")]
    reverse: bool,

    /// Only show these columns, comma separated
    #[arg(short, long, value_delimiter = ',')]
    columns: Vec<String>,

    /// Keep rows where column=value (repeatable)
    #[arg(short = 'w', long = "where")]
    filters: Vec<String>,

    /// Show at most this many rows
    #[arg(short = 'n', long)]
    limit: Option<usize>,
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("jtab: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let input = match &args.file {
        Some(path) => fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?,
        None if io::stdin().is_terminal() => return Err("give a file, or pipe JSON in".into()),
        None => {
            let mut s = String::new();
            io::stdin()
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())?;
            s
        }
    };

    let rows: Vec<Map<String, Value>> =
        match serde_json::from_str(&input).map_err(|e| e.to_string())? {
            Value::Array(items) => items
                .into_iter()
                .map(|v| match v {
                    Value::Object(map) => Ok(map),
                    other => Err(format!("expected objects in the array, found {other}")),
                })
                .collect::<Result<_, _>>()?,
            Value::Object(map) => vec![map],
            _ => return Err("expected a JSON array of objects".into()),
        };

    let mut rows: Vec<_> = rows
        .into_iter()
        .filter(|row| matches(row, &args.filters))
        .collect();

    if let Some(key) = &args.sort {
        rows.sort_by(|a, b| {
            let order = compare(a.get(key), b.get(key));
            if args.reverse { order.reverse() } else { order }
        });
    }
    if let Some(n) = args.limit {
        rows.truncate(n);
    }

    let columns = if args.columns.is_empty() {
        let mut seen: Vec<String> = Vec::new();
        for key in rows.iter().flat_map(|r| r.keys()) {
            if !seen.contains(key) {
                seen.push(key.clone());
            }
        }
        seen
    } else {
        args.columns.clone()
    };

    let mut table = Table::new();
    table
        .load_style(UTF8_FULL_CONDENSED.with_rounded_corners())
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(
            columns
                .iter()
                .map(|c| Cell::new(c).add_attribute(Attribute::Bold)),
        );
    for row in &rows {
        table.add_row(columns.iter().map(|c| Cell::new(display(row.get(c)))));
    }

    println!("{table}");
    println!("{} row(s)", rows.len());
    Ok(())
}

fn matches(row: &Map<String, Value>, filters: &[String]) -> bool {
    filters.iter().all(|f| match f.split_once('=') {
        Some((key, want)) => display(row.get(key)).eq_ignore_ascii_case(want),
        None => row.contains_key(f),
    })
}

fn compare(a: Option<&Value>, b: Option<&Value>) -> Ordering {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x
            .as_f64()
            .partial_cmp(&y.as_f64())
            .unwrap_or(Ordering::Equal),
        _ => display(a).cmp(&display(b)),
    }
}

fn display(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| display(Some(v)))
            .collect::<Vec<_>>()
            .join(", "),
        Some(other) => other.to_string(),
    }
}
