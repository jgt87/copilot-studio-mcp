/**
 * The pieces every Dataverse call shares: the token scope, the Web API base
 * URL, the OData headers, and reading a formatted value (the display name
 * Dataverse returns alongside a lookup or option set when asked for it).
 */


export function dataverseScope(envUrl: string): string {
  return `${envUrl.replace(/\/+$/, "")}/.default`;
}

export function api(envUrl: string): string {
  return `${envUrl.replace(/\/+$/, "")}/api/data/v9.2`;
}

export const ODATA_HEADERS = { "OData-MaxVersion": "4.0", "OData-Version": "4.0" };

/** Same, plus display names for lookups and option sets (`<field>@OData.Community.Display.V1.FormattedValue`). */
export const FORMATTED_HEADERS = { ...ODATA_HEADERS, Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };

export function formatted(row: Record<string, unknown>, field: string): string | null {
  const v = row[`${field}@OData.Community.Display.V1.FormattedValue`];
  return typeof v === "string" && v.trim() ? v : null;
}
