// Management code format: ele_YYYYMMDD_<uuid-with-underscores>
// e.g. ele_20260802_abc123de_f456_7890_abcd_ef1234567890
// Format: ele_YYYYMMDD_xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx (UUID with _ instead of -)
const MANAGEMENT_CODE_RE = /ele_\d{8}_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}/i

export interface InventoryListingInput {
  ebayItemId: string
  customLabel: string | null
  title: string
  imageUrl?: string | null
  currentPrice: number | null
  quantity: number | null
  quantitySold: number | null
  listingStatus: string | null
  startTime: string | null
  endTime: string | null
}

/**
 * Extract the management code from a CustomLabel string.
 * Returns null if not found.
 */
export function extractSourceLookupCode(customLabel: string | null): string | null {
  if (!customLabel) return null
  const m = customLabel.match(MANAGEMENT_CODE_RE)
  return m ? m[0] : null
}

// CSV column name aliases (eBay File Exchange header names)
const COLUMN_ALIASES: Record<string, string> = {
  'Item number': 'ebayItemId',
  'ItemID': 'ebayItemId',
  'Custom label (SKU)': 'customLabel',
  'CustomLabel': 'customLabel',
  'Title': 'title',
  'Current price': 'currentPrice',
  'StartPrice': 'currentPrice',
  'Quantity': 'quantity',
  'Quantity sold': 'quantitySold',
  'QuantitySold': 'quantitySold',
  'Listing status': 'listingStatus',
  'ListingStatus': 'listingStatus',
  'Start date': 'startTime',
  'StartTime': 'startTime',
  'End date': 'endTime',
  'EndTime': 'endTime',
}

/**
 * Parse a single CSV line respecting double-quote escaping.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) {
      fields.push('')
      break
    }
    if (line[i] === '"') {
      // quoted field
      let field = ''
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"'
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          field += line[i++]
        }
      }
      fields.push(field)
      if (line[i] === ',') i++
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) {
        fields.push(line.slice(i))
        break
      }
      fields.push(line.slice(i, end))
      i = end + 1
    }
  }
  return fields
}

/**
 * Parse eBay active listings CSV (File Exchange / Report format).
 * Returns parsed rows; skips rows missing ebayItemId or title.
 */
export function parseEbayActiveListingsCsv(csv: string): InventoryListingInput[] {
  const lines = csv.split(/\r?\n/)
  if (lines.length < 2) return []

  const rawHeaders = parseCsvLine(lines[0])
  const headers = rawHeaders.map((h) => COLUMN_ALIASES[h.trim()] ?? h.trim())

  const results: InventoryListingInput[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = values[idx]?.trim() ?? ''
    })

    const ebayItemId = row['ebayItemId']
    const title = row['title']
    if (!ebayItemId || !title) continue

    const parseNum = (v: string | undefined): number | null => {
      if (!v) return null
      const n = parseFloat(v.replace(/,/g, ''))
      return isFinite(n) ? n : null
    }

    results.push({
      ebayItemId,
      customLabel: row['customLabel'] || null,
      title,
      imageUrl: null,
      currentPrice: parseNum(row['currentPrice']),
      quantity: parseNum(row['quantity']) != null ? Math.round(parseNum(row['quantity'])!) : null,
      quantitySold: parseNum(row['quantitySold']) != null ? Math.round(parseNum(row['quantitySold'])!) : null,
      listingStatus: row['listingStatus'] || null,
      startTime: row['startTime'] || null,
      endTime: row['endTime'] || null,
    })
  }

  return results
}
