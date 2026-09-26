/**
 * Default ELSTER-oriented draft mapping for the `private-de` template.
 *
 * Groupings name the form a user is likely to copy values into and nothing
 * more; every label says "prepared". Sections without an obvious home
 * (`tax_advice`, `education`, `uncategorized`) are deliberately left unmapped
 * so they surface in the review block instead of being placed by guesswork.
 * Users configure their own mapping the same way they configure templates.
 */
import type { ElsterDraftMapping } from "../elster-draft/types.js";
import { PRIVATE_DE_TEMPLATE } from "./private-de.js";

export const ELSTER_DRAFT_MAPPING_PRIVATE_DE: ElsterDraftMapping = {
  id: "elster-draft-private-de",
  templateId: PRIVATE_DE_TEMPLATE.id,
  version: 1,
  minTaxYear: 2025,
  groups: [
    {
      id: "anlage_v_income",
      anlage: "Anlage V",
      lineLabel: "Rental income (prepared)",
      description: "Reviewed rental income lines. Verify per property before copying.",
      sectionIds: ["rental_property"],
      accountPatterns: ["Income:Rental", "Income:Rental:*"],
    },
    {
      id: "anlage_v_expenses",
      anlage: "Anlage V",
      lineLabel: "Rental expenses (prepared)",
      description:
        "Reviewed real-estate expense lines other than depreciation. Split per property and check evidence.",
      sectionIds: ["rental_property"],
      accountPatterns: ["Expenses:RealEstate:*"],
    },
    {
      id: "anlage_v_depreciation",
      anlage: "Anlage V",
      lineLabel: "Depreciation / AfA (prepared)",
      description:
        "Reviewed depreciation postings from configured schedules; compare with depreciation-schedules.csv.",
      sectionIds: ["depreciation"],
    },
    {
      id: "anlage_kap_evidence",
      anlage: "Anlage KAP",
      lineLabel: "Capital income evidence (prepared)",
      description:
        "Reviewed interest, dividend, and investment-related lines. Broker tax statements remain the primary source; compare with investment-evidence.csv.",
      sectionIds: ["capital_income"],
    },
    {
      id: "sonderausgaben_donations",
      anlage: "Anlage Sonderausgaben",
      lineLabel: "Donations (prepared)",
      description: "Reviewed donation lines; each needs a donation receipt.",
      sectionIds: ["donations"],
    },
    {
      id: "sonderausgaben_insurance",
      anlage: "Anlage Sonderausgaben / Anlage Vorsorgeaufwand",
      lineLabel: "Insurance (prepared)",
      description:
        "Reviewed insurance lines. Which form field, if any, applies depends on the policy type — review each line.",
      sectionIds: ["insurance"],
    },
    {
      id: "anlage_n_work_related",
      anlage: "Anlage N",
      lineLabel: "Work-related expenses (prepared)",
      description: "Reviewed lines configured as work-related.",
      sectionIds: ["work_related"],
    },
    {
      id: "aussergewoehnliche_belastungen_medical",
      anlage: "Anlage Außergewöhnliche Belastungen",
      lineLabel: "Medical expenses (prepared)",
      description: "Reviewed medical lines; reimbursements must be netted by the user.",
      sectionIds: ["medical"],
    },
    {
      id: "haushaltsnahe_dienstleistungen",
      anlage: "Anlage Haushaltsnahe Aufwendungen",
      lineLabel: "Household services (prepared)",
      description: "Reviewed household-service lines; invoices and bank transfers required.",
      sectionIds: ["household_services"],
    },
  ],
};
