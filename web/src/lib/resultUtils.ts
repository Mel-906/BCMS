export const SUMMARY_HEADERS = [
  "名前",
  "名前（英語）",
  "職業",
  "Tel",
  "e-mail",
  "所属",
  "代表Tel",
  "所属住所郵便番号",
  "所属住所",
  "URL",
  "その他",
] as const;

export type SummaryFields = Record<(typeof SUMMARY_HEADERS)[number], string>;

export interface ResultPayload {
  name: {
    jp: string;
    en: string;
  };
  occupation: string;
  contact: {
    tel: string[];
    email: string[];
    url: string[];
  };
  organization: {
    name: string;
    representative_tel: string;
    address: {
      zip: string;
      full: string;
    };
  };
  notes: string;
  raw_summary: SummaryFields;
  [key: string]: unknown;
}

export interface FlattenedField {
  key_path: string;
  value_text: string | null;
  value_numeric: number | null;
  value_boolean: boolean | null;
  value_json: string | null;
}

const toList = (value: string | undefined) =>
  value
    ?.split(";")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];

export function buildResultPayload(summary: SummaryFields): ResultPayload {
  return {
    name: {
      jp: summary["名前"] ?? "",
      en: summary["名前（英語）"] ?? "",
    },
    occupation: summary["職業"] ?? "",
    contact: {
      tel: toList(summary["Tel"]),
      email: toList(summary["e-mail"]),
      url: toList(summary["URL"]),
    },
    organization: {
      name: summary["所属"] ?? "",
      representative_tel: summary["代表Tel"] ?? "",
      address: {
        zip: summary["所属住所郵便番号"] ?? "",
        full: summary["所属住所"] ?? "",
      },
    },
    notes: summary["その他"] ?? "",
    raw_summary: summary,
  };
}

export function flattenPayload(payload: unknown): FlattenedField[] {
  const rows: FlattenedField[] = [];

  function walk(prefix: string, value: unknown) {
    if (Array.isArray(value)) {
      const jsonValue = JSON.stringify(value);
      rows.push({
        key_path: prefix,
        value_text: null,
        value_numeric: null,
        value_boolean: null,
        value_json: jsonValue,
      });
      value.forEach((item, index) => {
        const childPrefix = `${prefix}[${index}]`;
        walk(childPrefix, item);
      });
      return;
    }

    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
        const childPrefix = prefix ? `${prefix}.${key}` : key;
        walk(childPrefix, child);
      });
      return;
    }

    const entry: FlattenedField = {
      key_path: prefix,
      value_text: null,
      value_numeric: null,
      value_boolean: null,
      value_json: null,
    };

    if (typeof value === "string") {
      entry.value_text = value;
    } else if (typeof value === "number") {
      entry.value_numeric = value;
    } else if (typeof value === "boolean") {
      entry.value_boolean = value;
    } else if (value === null || value === undefined) {
      // leave as nulls
    } else {
      entry.value_json = JSON.stringify(value);
    }

    rows.push(entry);
  }

  walk("", payload);
  return rows;
}

export function parseSummary(summary: unknown): SummaryFields {
  if (!summary) {
    return Object.fromEntries(SUMMARY_HEADERS.map((key) => [key, ""])) as SummaryFields;
  }
  if (typeof summary === "string") {
    try {
      const parsed = JSON.parse(summary);
      return parseSummary(parsed);
    } catch {
      return Object.fromEntries(SUMMARY_HEADERS.map((key) => [key, ""])) as SummaryFields;
    }
  }
  if (typeof summary === "object") {
    const record = summary as Record<string, unknown>;
    return Object.fromEntries(
      SUMMARY_HEADERS.map((key) => [key, typeof record[key] === "string" ? (record[key] as string) : ""]),
    ) as SummaryFields;
  }
  return Object.fromEntries(SUMMARY_HEADERS.map((key) => [key, ""])) as SummaryFields;
}
