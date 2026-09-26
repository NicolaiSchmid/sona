/**
 * Synthetic Portfolio Performance exports for tests. ISINs use the reserved
 * test prefixes ("XS0000…", "DE000TEST…") and no row reflects a real holding.
 */

/** German-locale transactions export (semicolon, "1.005,00", "02.03.2026"). */
export const PP_TRANSACTIONS_DE_CSV = [
  "Datum;Typ;Wert;Buchungswährung;Bruttobetrag;Währung Bruttobetrag;Wechselkurs;Gebühren;Steuern;Stück;ISIN;WKN;Ticker-Symbol;Wertpapiername;Notiz;Konto;Depot",
  "01.03.2026;Einlage;2.000,00;EUR;;;;;;;;;;;Überweisung Girokonto;Verrechnungskonto;",
  "02.03.2026;Kauf;-1.005,00;EUR;;;;5,00;;10;XS0000000001;TEST01;TST;Synthetic World ETF;;Verrechnungskonto;Depot A",
  "15.05.2026;Dividende;78,70;EUR;100,00;USD;1,08;;13,89;50;US0000000TEST;TEST02;SYN;Synthetic Inc;Quartalsdividende;Verrechnungskonto;Depot A",
  "30.06.2026;Gebühren;-4,90;EUR;;;;;;;;;;;Depotgebühr;Verrechnungskonto;",
  "10.07.2026;Verkauf;995,00;EUR;;;;5,00;;10;XS0000000001;TEST01;TST;Synthetic World ETF;;Verrechnungskonto;Depot A",
  "20.07.2026;Entnahme;-300,00;EUR;;;;;;;;;;;Rücküberweisung;Verrechnungskonto;",
  "",
].join("\n");

/** English-locale export with comma delimiter and "1,005.00" numbers. */
export const PP_TRANSACTIONS_EN_CSV = [
  "Date,Type,Value,Transaction Currency,Gross Amount,Currency Gross Amount,Exchange Rate,Fees,Taxes,Shares,ISIN,WKN,Ticker Symbol,Security Name,Note,Cash Account,Securities Account",
  '2026-03-01,Deposit,"2,000.00",EUR,,,,,,,,,,,Bank transfer,Clearing,',
  '2026-03-02,Buy,"-1,005.00",EUR,,,,5.00,,10,XS0000000001,TEST01,TST,Synthetic World ETF,,Clearing,Depot A',
  "2026-05-15,Dividend,78.70,EUR,100.00,USD,1.08,,13.89,50,US0000000TEST,TEST02,SYN,Synthetic Inc,Quarterly dividend,Clearing,Depot A",
].join("\r\n");

/**
 * Export with two malformed rows (unknown type, bad number) between valid ones.
 * The valid rows must import; the bad rows must surface as row errors.
 */
export const PP_TRANSACTIONS_WITH_ERRORS_CSV = [
  "Datum;Typ;Wert;Buchungswährung;Gebühren;Steuern;Stück;ISIN;Wertpapiername;Notiz",
  "01.03.2026;Einlage;500,00;EUR;;;;;;",
  "02.03.2026;Sparplan;100,00;EUR;;;;XS0000000001;Synthetic World ETF;",
  "03.03.2026;Kauf;abc;EUR;;;1;XS0000000001;Synthetic World ETF;",
  "04.03.2026;Kauf;-100,00;EUR;;;;;;kein Wertpapier",
  "31.02.2026;Einlage;1,00;EUR;;;;;;",
  "05.03.2026;Zinsen;1,23;EUR;;;;;;",
].join("\n");

/** Two identical same-day fee rows that must both survive import. */
export const PP_DUPLICATE_ROWS_CSV = [
  "Datum;Typ;Wert;Buchungswährung;Notiz",
  "30.06.2026;Gebühren;-1,00;EUR;Ordergebühr",
  "30.06.2026;Gebühren;-1,00;EUR;Ordergebühr",
].join("\n");

/** German-locale holdings (statement of assets) export. */
export const PP_HOLDINGS_DE_CSV = [
  "Name;ISIN;WKN;Ticker-Symbol;Stück;Kurs;Marktwert;Währung;Depot",
  "Synthetic World ETF;XS0000000001;TEST01;TST;10;110,50;1.105,00;EUR;Depot A",
  "Synthetic Inc;US0000000TEST;TEST02;SYN;50;42,00;2.100,00;EUR;Depot A",
  ";;;;;;nicht-numerisch;EUR;Depot A",
].join("\n");
