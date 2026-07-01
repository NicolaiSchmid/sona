/**
 * Default German private-individual tax template.
 *
 * Sections map user-reviewed ledger accounts to preparation-oriented export
 * categories. Wording is deliberately neutral: nothing here claims an amount is
 * legally deductible — that is a human/advisor decision.
 */
import type { TaxSection, TaxTemplate } from "../export/types.js";

const UNCATEGORIZED: TaxSection = {
  id: "uncategorized",
  title: "Uncategorized (review required)",
  description: "Postings that matched no configured section. Review before export.",
  accountPatterns: [],
  receiptRequired: false,
};

// Depreciation is listed before the general real-estate section so a
// depreciation posting maps to its own section rather than rental maintenance.
const SECTIONS: TaxSection[] = [
  {
    id: "depreciation",
    title: "Depreciation schedules (AfA preparation)",
    description: "Configured depreciation postings for real estate and assets.",
    accountPatterns: ["Expenses:RealEstate:Depreciation", "Expenses:Depreciation:*"],
    receiptRequired: true,
  },
  {
    id: "rental_property",
    title: "Rental property (Anlage V preparation)",
    description: "Rental income and real-estate expenses prepared for Anlage V.",
    accountPatterns: ["Income:Rental", "Income:Rental:*", "Expenses:RealEstate:*"],
    receiptRequired: true,
  },
  {
    id: "capital_income",
    title: "Capital income & investment-related",
    description: "Interest/dividend income and investment-related fees.",
    accountPatterns: [
      "Income:Interest",
      "Income:Dividends",
      "Expenses:Investment:*",
      "Expenses:InvestmentFees:*",
    ],
    receiptRequired: false,
  },
  {
    id: "work_related",
    title: "Work-related expenses",
    description: "Expenses configured as work-related for preparation.",
    accountPatterns: ["Expenses:WorkRelated", "Expenses:WorkRelated:*"],
    receiptRequired: false,
  },
  {
    id: "tax_advice",
    title: "Tax advice expenses",
    description: "Fees configured as tax-advice-related for preparation.",
    accountPatterns: ["Expenses:TaxAdvice", "Expenses:TaxAdvice:*"],
    receiptRequired: true,
  },
  {
    id: "donations",
    title: "Donations",
    description: "Configured donation postings prepared for review.",
    accountPatterns: ["Expenses:Donations", "Expenses:Donations:*"],
    receiptRequired: true,
  },
  {
    id: "insurance",
    title: "Insurance",
    description: "Configured insurance postings prepared for review.",
    accountPatterns: ["Expenses:Insurance", "Expenses:Insurance:*"],
    receiptRequired: false,
  },
  {
    id: "household_services",
    title: "Household services",
    description: "Household-service postings prepared for review.",
    accountPatterns: ["Expenses:HouseholdServices", "Expenses:HouseholdServices:*"],
    receiptRequired: false,
  },
  {
    id: "medical",
    title: "Medical expenses",
    description: "Configured medical postings prepared for review.",
    accountPatterns: ["Expenses:Medical", "Expenses:Medical:*"],
    receiptRequired: true,
  },
  {
    id: "education",
    title: "Education / training",
    description: "Education and training expenses prepared for review.",
    accountPatterns: ["Expenses:Education", "Expenses:Education:*"],
    receiptRequired: false,
  },
];

export const PRIVATE_DE_TEMPLATE: TaxTemplate = {
  id: "private-de",
  jurisdiction: "DE",
  audience: "private_individual",
  sections: [...SECTIONS, UNCATEGORIZED],
  uncategorizedSectionId: UNCATEGORIZED.id,
};
