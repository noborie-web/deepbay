import { describe, it, expect } from 'vitest'
import { extractSourceLookupCode, parseEbayActiveListingsCsv } from '@/lib/inventory'
import { parseGetMyeBaySellingResponse } from '@/lib/ebay-inventory'

// ---------------------------------------------------------------------------
// extractSourceLookupCode
// ---------------------------------------------------------------------------
describe('extractSourceLookupCode', () => {
  it('returns management code from plain custom label', () => {
    const code = 'ele_20260802_abc123de_f456_7890_abcd_ef1234567890'
    expect(extractSourceLookupCode(code)).toBe(code)
  })

  it('extracts code embedded in a longer string', () => {
    const code = 'ele_20260802_abc123de_f456_7890_abcd_ef1234567890'
    expect(extractSourceLookupCode(`prefix_${code}_suffix`)).toBe(code)
  })

  it('returns null for null input', () => {
    expect(extractSourceLookupCode(null)).toBeNull()
  })

  it('returns null when no management code present', () => {
    expect(extractSourceLookupCode('some-random-sku-123')).toBeNull()
  })

  it('returns null for partial code (too short uuid part)', () => {
    // uuid part must be at least 32 hex/underscore chars
    expect(extractSourceLookupCode('ele_20260802_abc')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseEbayActiveListingsCsv
// ---------------------------------------------------------------------------
describe('parseEbayActiveListingsCsv', () => {
  const makecsv = (rows: string[]) =>
    ['Item number,Custom label (SKU),Title,Current price,Quantity,Quantity sold,Listing status,Start date,End date', ...rows].join('\n')

  it('parses a basic row', () => {
    const csv = makecsv(['110123456789,ele_20260802_abc123de_f456_7890_abcd_ef1234,Test Item,29.99,3,1,Active,2026-08-01T00:00:00.000Z,2026-09-01T00:00:00.000Z'])
    const result = parseEbayActiveListingsCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      ebayItemId: '110123456789',
      customLabel: 'ele_20260802_abc123de_f456_7890_abcd_ef1234',
      title: 'Test Item',
      currentPrice: 29.99,
      quantity: 3,
      quantitySold: 1,
      listingStatus: 'Active',
    })
  })

  it('handles quoted fields with commas', () => {
    const csv = makecsv(['110987654321,SKU-001,"Title, with comma",15.00,1,0,Active,,'])
    const result = parseEbayActiveListingsCsv(csv)
    expect(result[0].title).toBe('Title, with comma')
  })

  it('handles escaped double-quotes', () => {
    const csv = makecsv(['110000000001,SKU-002,"Title ""quoted""",10.00,1,0,Active,,'])
    const result = parseEbayActiveListingsCsv(csv)
    expect(result[0].title).toBe('Title "quoted"')
  })

  it('skips rows missing ebayItemId', () => {
    const csv = makecsv([',SKU-X,No ID Item,9.99,1,0,Active,,'])
    expect(parseEbayActiveListingsCsv(csv)).toHaveLength(0)
  })

  it('skips rows missing title', () => {
    const csv = makecsv(['110111222333,SKU-Y,,9.99,1,0,Active,,'])
    expect(parseEbayActiveListingsCsv(csv)).toHaveLength(0)
  })

  it('parses price with comma thousands separator', () => {
    const csv2 = makecsv(['110222333444,SKU-Z,Item,"1,234.56",5,0,Active,,'])
    const r2 = parseEbayActiveListingsCsv(csv2)
    expect(r2[0].currentPrice).toBe(1234.56)
  })

  it('returns empty array for header-only CSV', () => {
    expect(parseEbayActiveListingsCsv('Item number,Title')).toHaveLength(0)
  })

  it('returns empty array for empty string', () => {
    expect(parseEbayActiveListingsCsv('')).toHaveLength(0)
  })

  it('accepts CustomLabel alias column name', () => {
    const csv = ['Item number,CustomLabel,Title,StartPrice,Quantity,QuantitySold,ListingStatus,StartTime,EndTime',
      '110333444555,MY-SKU,Alt Title,19.99,2,0,Active,,'].join('\n')
    const result = parseEbayActiveListingsCsv(csv)
    expect(result[0].customLabel).toBe('MY-SKU')
    expect(result[0].currentPrice).toBe(19.99)
  })

  it('sets null for missing optional fields', () => {
    const csv = makecsv(['110444555666,,No SKU Item,,,,,, '])
    const result = parseEbayActiveListingsCsv(csv)
    expect(result[0].customLabel).toBeNull()
    expect(result[0].currentPrice).toBeNull()
    expect(result[0].quantity).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseGetMyeBaySellingResponse
// ---------------------------------------------------------------------------
describe('parseGetMyeBaySellingResponse', () => {
  const makeXml = (items: string, totalPages = 1, pageNum = 1) => `
<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>${items}</ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>${totalPages}</TotalNumberOfPages>
      <PageNumber>${pageNum}</PageNumber>
    </PaginationResult>
  </ActiveList>
</GetMyeBaySellingResponse>`

  const item = (id: string, sku: string, title: string, price: string) => `
<Item>
  <ItemID>${id}</ItemID>
  <SKU>${sku}</SKU>
  <Title>${title}</Title>
  <PictureDetails><GalleryURL>https://i.ebayimg.com/images/g/test/s-l140.jpg</GalleryURL></PictureDetails>
  <CurrentPrice>${price}</CurrentPrice>
  <Quantity>2</Quantity>
  <QuantitySold>1</QuantitySold>
  <ListingStatus>Active</ListingStatus>
  <StartTime>2026-08-01T00:00:00.000Z</StartTime>
  <EndTime>2026-09-01T00:00:00.000Z</EndTime>
</Item>`

  it('parses a single item', () => {
    const xml = makeXml(item('110000000001', 'ele_20260802_abc_def', 'Test Product', '25.00'))
    const { items, hasMore, totalPages } = parseGetMyeBaySellingResponse(xml)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      ebayItemId: '110000000001',
      customLabel: 'ele_20260802_abc_def',
      title: 'Test Product',
      imageUrl: 'https://i.ebayimg.com/images/g/test/s-l140.jpg',
      currentPrice: 25.00,
      quantity: 2,
      quantitySold: 1,
      listingStatus: 'Active',
    })
    expect(hasMore).toBe(false)
    expect(totalPages).toBe(1)
  })

  it('parses multiple items', () => {
    const xml = makeXml(
      item('110000000001', 'SKU-A', 'Item A', '10.00') +
      item('110000000002', 'SKU-B', 'Item B', '20.00')
    )
    const { items } = parseGetMyeBaySellingResponse(xml)
    expect(items).toHaveLength(2)
    expect(items[1].ebayItemId).toBe('110000000002')
  })

  it('reports hasMore when more pages exist', () => {
    const xml = makeXml(item('110000000001', 'S', 'T', '5.00'), 3, 1)
    const { hasMore, totalPages } = parseGetMyeBaySellingResponse(xml)
    expect(hasMore).toBe(true)
    expect(totalPages).toBe(3)
  })

  it('reports hasMore=false on last page', () => {
    const xml = makeXml(item('110000000001', 'S', 'T', '5.00'), 3, 3)
    const { hasMore } = parseGetMyeBaySellingResponse(xml)
    expect(hasMore).toBe(false)
  })

  it('throws on Failure ack', () => {
    const xml = `<GetMyeBaySellingResponse>
      <Ack>Failure</Ack>
      <Errors><LongMessage>Invalid token</LongMessage></Errors>
    </GetMyeBaySellingResponse>`
    expect(() => parseGetMyeBaySellingResponse(xml)).toThrow('Invalid token')
  })

  it('returns empty items for empty ActiveList', () => {
    const xml = makeXml('')
    const { items } = parseGetMyeBaySellingResponse(xml)
    expect(items).toHaveLength(0)
  })
})
