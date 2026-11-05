/** Tax year summary (a starting point for tax software or an accountant; not tax advice). */

export interface TaxItem {
  id: string;
  date: string;
  name: string;
  /** Positive = money in for income items, money out for everything else. */
  cents: number;
  categoryName: string | null;
  accountName: string;
  notes: string | null;
  tags: string[];
}

export interface TaxSection {
  key: "income" | "deductible" | "mortgage" | "charity" | "medical" | "taxes";
  title: string;
  /** How items were picked, shown to the user. */
  basis: string;
  totalCents: number;
  byCategory: { name: string; cents: number }[];
  items: TaxItem[];
}

export interface TaxYear {
  year: number;
  /** Years that have any transactions, newest first. */
  years: number[];
  sections: TaxSection[];
  /** Crypto gains come from a Koinly import (not built yet). */
  crypto: null;
}
