import { NextResponse } from 'next/server'
import * as cheerio from 'cheerio'

// Known VeRO brands from eBay's public participant list and community knowledge
const PRESET_BRANDS: string[] = [
  // Luxury Fashion
  'Louis Vuitton', 'Gucci', 'Hermès', 'Chanel', 'Prada', 'Burberry', 'Versace',
  'Valentino', 'Givenchy', 'Dior', 'Fendi', 'Bottega Veneta', 'Balenciaga',
  'Saint Laurent', 'Celine', 'Loewe', 'Moncler', 'Off-White', 'Ferragamo',
  'Balmain', 'Alexander McQueen', 'Stella McCartney', 'Vivienne Westwood',
  'Moschino', 'Dolce & Gabbana', 'Armani', 'Hugo Boss', 'Zegna',
  // Sportswear
  'Nike', 'Adidas', 'Under Armour', 'Puma', 'New Balance', 'Reebok',
  'The North Face', 'Patagonia', 'Columbia', 'Asics', 'Mizuno', 'Saucony',
  'Brooks', 'Salomon', 'Arc\'teryx', 'Mammut', 'Lululemon', 'Champion',
  // Footwear
  'UGG', 'Timberland', 'Dr. Martens', 'Vans', 'Converse', 'Jordan',
  'Birkenstock', 'Crocs', 'Skechers', 'Merrell', 'Keen', 'Sorel',
  // Streetwear
  'Supreme', 'Stone Island', 'Kenzo', 'Fred Perry', 'Lacoste', 'Polo Ralph Lauren',
  'Tommy Hilfiger', 'Calvin Klein', 'Levi\'s', 'Wrangler', 'Lee', 'Carhartt',
  'Stussy', 'A Bathing Ape', 'Palace', 'Thrasher', 'Obey', 'Vans',
  // Tech
  'Apple', 'Samsung', 'Sony', 'Microsoft', 'Bose', 'Beats', 'Dyson',
  'Fitbit', 'GoPro', 'Garmin', 'Logitech', 'Razer', 'Corsair', 'ASUS',
  // Watches & Jewelry
  'Rolex', 'Omega', 'Breitling', 'TAG Heuer', 'Cartier', 'Tiffany',
  'Swarovski', 'Pandora', 'Seiko', 'Citizen', 'Casio G-Shock', 'IWC',
  'Patek Philippe', 'Audemars Piguet', 'Longines', 'Tissot', 'Hamilton',
  // Entertainment / Anime / Games
  'Disney', 'Marvel', 'Star Wars', 'Universal Studios', 'Warner Bros',
  'Hello Kitty', 'Sanrio', 'Bandai', 'Funko', 'LEGO',
  'Nintendo', 'PlayStation', 'Xbox', 'Sega',
  'Pokemon', 'Dragon Ball', 'One Piece', 'Naruto', 'Demon Slayer',
  'My Neighbor Totoro', 'Studio Ghibli', 'Gundam',
  // Sports Teams / Leagues
  'NFL', 'NBA', 'MLB', 'NHL', 'FIFA',
  // Beauty & Cosmetics
  'MAC Cosmetics', 'Urban Decay', 'NARS', 'Charlotte Tilbury', 'Too Faced',
  'Kylie Cosmetics', 'Fenty Beauty', 'Giorgio Armani Beauty',
  // Bags & Accessories
  'Coach', 'Kate Spade', 'Michael Kors', 'Tory Burch', 'Longchamp',
  'Mulberry', 'Furla', 'MCM', 'Moschino', 'Goyard',
  // Other
  'Mattel', 'Hasbro', 'Hot Wheels', 'Barbie', 'Transformers',
  'Zippo', 'Victorinox', 'Leatherman', 'Stanley', 'Yeti', 'Hydro Flask',
  'Ray-Ban', 'Oakley', 'Prada Eyewear', 'Maui Jim',
]

async function fetchEbayVeroList(): Promise<string[]> {
  const res = await fetch('https://www.ebay.com/sellercenter/resources/verified-rights-owner-profiles', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    next: { revalidate: 0 },
  })

  if (!res.ok) return []

  const html = await res.text()
  const $ = cheerio.load(html)
  const brands: string[] = []

  // Try various selectors that eBay Seller Center might use
  $('a[href*="vero"], .vero-profile, .brand-name, [class*="profile"] a, [class*="brand"] a').each((_, el) => {
    const text = $(el).text().trim()
    if (text && text.length > 1 && text.length < 80) brands.push(text)
  })

  // Fallback: extract from list items in the main content area
  if (brands.length === 0) {
    $('main li, article li, .content li').each((_, el) => {
      const text = $(el).text().trim()
      if (text && text.length > 1 && text.length < 80 && !/^[0-9]/.test(text)) {
        brands.push(text)
      }
    })
  }

  return [...new Set(brands)]
}

export async function GET() {
  let liveBrands: string[] = []
  let source: 'live' | 'preset' = 'preset'

  try {
    liveBrands = await fetchEbayVeroList()
    if (liveBrands.length > 10) source = 'live'
  } catch {
    // fall through to preset
  }

  const brands = liveBrands.length > 10
    ? [...new Set([...liveBrands, ...PRESET_BRANDS])].sort((a, b) => a.localeCompare(b))
    : [...PRESET_BRANDS].sort((a, b) => a.localeCompare(b))

  return NextResponse.json({ brands, source, count: brands.length })
}
