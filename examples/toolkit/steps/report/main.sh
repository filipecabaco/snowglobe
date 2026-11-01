#!/bin/sh
# jq + sqlite: totals by vendor, as CSV
set -eu
jq -r '.[] | [.invoice, .vendor, .total] | @csv' in/invoices.json > rows.csv
sqlite3 -batch report.db <<'SQL'
CREATE TABLE invoices (invoice TEXT, vendor TEXT, total REAL);
.mode csv
.import rows.csv invoices
.headers on
.output out/report.csv
SELECT vendor, count(*) AS invoices, printf('%.2f', sum(total)) AS total FROM invoices GROUP BY vendor ORDER BY sum(total) DESC;
.output stdout
.mode box
SELECT vendor, count(*) AS invoices, printf('%.2f', sum(total)) AS total FROM invoices GROUP BY vendor ORDER BY sum(total) DESC;
SQL
