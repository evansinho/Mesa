/**
 * Parsing a pasted or uploaded table of prospects.
 *
 * Lives on the server rather than only in the console because the console's
 * preview and the actual write must agree, and the only way to guarantee that
 * is for one implementation to produce both.
 */

export interface RawRow {
  businessName?: string | null
  phone?: string | null
  instagramHandle?: string | null
  contactName?: string | null
  sourceDetail?: string | null
}

export interface ParseResult {
  rows: RawRow[]
  /** Lines we could not read, with the line number as the user sees it. */
  errors: { line: number; reason: string }[]
  /** The header we recognised, so the console can show what it matched. */
  columns: Record<string, string | null>
}

const ALIASES: Record<keyof RawRow, readonly string[]> = {
  businessName: ['business_name', 'business name', 'business', 'name', 'company', 'vendor'],
  phone: ['phone', 'phone_number', 'phone number', 'number', 'whatsapp', 'mobile', 'tel'],
  instagramHandle: ['instagram_handle', 'instagram', 'ig', 'handle', 'ig_handle'],
  contactName: ['contact_name', 'contact name', 'contact', 'owner', 'person'],
  sourceDetail: ['source_detail', 'source detail', 'detail', 'notes', 'note'],
}

/**
 * Split a line on commas or tabs.
 *
 * Tabs matter as much as commas here: copying a range out of Google Sheets or
 * Excel puts tab-separated text on the clipboard, and pasting that is the way
 * most people will actually use this. A file drop gives commas.
 */
function splitLine(line: string, delimiter: ',' | '\t'): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }   // "" is an escaped quote
        else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Guess the delimiter from the header line.
 *
 * A tab anywhere in the header is decisive: spreadsheet paste always uses them
 * and a business name legitimately contains commas ("Ronke Foods, Lekki"),
 * so counting which occurs more often would pick wrong on a one-column paste.
 */
function detectDelimiter(header: string): ',' | '\t' {
  return header.includes('\t') ? '\t' : ','
}

export function parseProspectRows(text: string): ParseResult {
  const errors: ParseResult['errors'] = []
  const lines = text.split(/\r?\n/)

  // Track real line numbers so an error points at the line in the user's file,
  // not at an index into the filtered list.
  const numbered = lines
    .map((content, i) => ({ content, line: i + 1 }))
    .filter((l) => l.content.trim().length > 0)

  if (numbered.length === 0) {
    return { rows: [], errors: [{ line: 1, reason: 'nothing to import' }], columns: {} }
  }

  const delimiter = detectDelimiter(numbered[0].content)
  const header = splitLine(numbered[0].content, delimiter)
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))

  const cols: Partial<Record<keyof RawRow, number>> = {}
  const columns: Record<string, string | null> = {}
  for (const [field, aliases] of Object.entries(ALIASES) as [keyof RawRow, readonly string[]][]) {
    const index = header.findIndex((h) => aliases.includes(h))
    if (index !== -1) cols[field] = index
    columns[field] = index === -1 ? null : header[index]
  }

  if (cols.phone === undefined) {
    return {
      rows: [],
      errors: [{
        line: 1,
        reason: `no phone column found. Name one of: ${ALIASES.phone.join(', ')}`,
      }],
      columns,
    }
  }

  const rows: RawRow[] = []
  for (const { content, line } of numbered.slice(1)) {
    const cells = splitLine(content, delimiter)
    const at = (field: keyof RawRow): string | null => {
      const i = cols[field]
      if (i === undefined) return null
      return cells[i]?.trim().replace(/^"|"$/g, '') || null
    }

    const phone = at('phone')
    if (!phone) {
      errors.push({ line, reason: 'no phone' })
      continue
    }

    rows.push({
      phone,
      businessName: at('businessName'),
      instagramHandle: at('instagramHandle')?.replace(/^@/, '') ?? null,
      contactName: at('contactName'),
      sourceDetail: at('sourceDetail'),
    })
  }

  return { rows, errors, columns }
}
