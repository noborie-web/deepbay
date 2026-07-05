export interface EbayCategory {
  id: string
  name: string
}

export const EBAY_CATEGORIES: EbayCategory[] = [
  // Top Level
  { id: "11450", name: "Clothing, Shoes & Accessories" },
  { id: "293", name: "Consumer Electronics" },
  { id: "281", name: "Jewelry & Watches" },
  { id: "888", name: "Sporting Goods" },
  { id: "220", name: "Toys & Hobbies" },
  { id: "1", name: "Collectibles" },
  { id: "619", name: "Musical Instruments & Gear" },
  { id: "11700", name: "Home & Garden" },
  { id: "550", name: "Art" },
  { id: "267", name: "Books & Magazines" },
  { id: "26395", name: "Health & Beauty" },
  { id: "6000", name: "eBay Motors" },
  { id: "625", name: "Cameras & Photo" },
  { id: "58058", name: "Tablets & eBook Readers" },

  // Men's Clothing
  { id: "1059", name: "Men's Clothing" },
  { id: "57988", name: "Men's Coats & Jackets" },
  { id: "155183", name: "Men's Down & Puffer Jackets" },
  { id: "185100", name: "Men's T-Shirts" },
  { id: "53159", name: "Men's Casual Shirts" },
  { id: "57990", name: "Men's Dress Shirts" },
  { id: "57989", name: "Men's Pants" },
  { id: "11554", name: "Men's Jeans" },
  { id: "15689", name: "Men's Sweaters" },
  { id: "57991", name: "Men's Suits & Suit Separates" },
  { id: "15691", name: "Men's Shorts" },
  { id: "11484", name: "Men's Activewear" },
  { id: "11502", name: "Men's Hoodies & Sweatshirts" },
  { id: "11510", name: "Men's Swimwear" },
  { id: "57987", name: "Men's Underwear" },
  { id: "11510", name: "Men's Vests" },

  // Women's Clothing
  { id: "15724", name: "Women's Clothing" },
  { id: "63862", name: "Women's Coats & Jackets" },
  { id: "155184", name: "Women's Down & Puffer Jackets" },
  { id: "53548", name: "Women's Tops & Blouses" },
  { id: "11555", name: "Women's Jeans" },
  { id: "187651", name: "Women's Pants" },
  { id: "11555", name: "Women's Skirts" },
  { id: "11555", name: "Women's Dresses" },
  { id: "63864", name: "Women's Sweaters" },
  { id: "53557", name: "Women's Activewear" },
  { id: "63867", name: "Women's Hoodies & Sweatshirts" },
  { id: "53558", name: "Women's Swimwear" },
  { id: "63863", name: "Women's Lingerie & Sleepwear" },

  // Shoes - Men's
  { id: "93427", name: "Men's Shoes" },
  { id: "95672", name: "Men's Sneakers" },
  { id: "11504", name: "Men's Athletic Shoes" },
  { id: "11498", name: "Men's Dress Shoes" },
  { id: "11499", name: "Men's Boots" },
  { id: "11500", name: "Men's Loafers & Slip-Ons" },
  { id: "11501", name: "Men's Sandals & Flip Flops" },

  // Shoes - Women's
  { id: "3034", name: "Women's Shoes" },
  { id: "57929", name: "Women's Sneakers" },
  { id: "55793", name: "Women's Athletic Shoes" },
  { id: "45694", name: "Women's Heels" },
  { id: "11632", name: "Women's Boots" },
  { id: "11633", name: "Women's Flats" },
  { id: "11634", name: "Women's Sandals" },

  // Bags
  { id: "169291", name: "Bags, Purses & Wallets" },
  { id: "4250", name: "Women's Bags & Handbags" },
  { id: "155200", name: "Women's Wallets" },
  { id: "45333", name: "Men's Bags" },
  { id: "169288", name: "Backpacks" },
  { id: "169286", name: "Luggage & Travel Bags" },
  { id: "63852", name: "Briefcases" },
  { id: "169289", name: "Tote Bags" },
  { id: "169290", name: "Clutches & Evening Bags" },

  // Accessories
  { id: "169245", name: "Men's Accessories" },
  { id: "45238", name: "Women's Accessories" },
  { id: "169244", name: "Hats" },
  { id: "45232", name: "Men's Hats" },
  { id: "52365", name: "Women's Hats" },
  { id: "169234", name: "Scarves & Wraps" },
  { id: "169235", name: "Gloves & Mittens" },
  { id: "45220", name: "Belts" },
  { id: "169250", name: "Sunglasses" },
  { id: "2988", name: "Sunglasses & Sunglasses Accessories" },

  // Watches
  { id: "31387", name: "Watches" },
  { id: "10321", name: "Wristwatches" },
  { id: "260325", name: "Men's Wristwatches" },
  { id: "260324", name: "Women's Wristwatches" },
  { id: "3280", name: "Pocket Watches" },
  { id: "260326", name: "Unisex Adult Wristwatches" },
  { id: "57896", name: "Smart Watches" },
  { id: "178893", name: "Watch Parts, Tools & Guides" },

  // Jewelry
  { id: "10968", name: "Fine Jewelry" },
  { id: "10977", name: "Fashion Jewelry" },
  { id: "137843", name: "Fine Necklaces & Pendants" },
  { id: "164322", name: "Fashion Necklaces & Pendants" },
  { id: "10982", name: "Fine Rings" },
  { id: "164323", name: "Fashion Rings" },
  { id: "10985", name: "Fine Bracelets" },
  { id: "164324", name: "Fashion Bracelets" },
  { id: "10987", name: "Fine Earrings" },
  { id: "164325", name: "Fashion Earrings" },
  { id: "45390", name: "Anklets" },
  { id: "4726", name: "Diamond" },
  { id: "4727", name: "Gemstone" },

  // Electronics
  { id: "15032", name: "Cell Phones & Accessories" },
  { id: "9355", name: "Cell Phones & Smartphones" },
  { id: "182093", name: "Cell Phone Accessories" },
  { id: "171485", name: "Computers, Tablets & Network Hardware" },
  { id: "175672", name: "Laptops & Netbooks" },
  { id: "58058", name: "Tablets" },
  { id: "31388", name: "Digital Cameras" },
  { id: "30078", name: "Film Cameras" },
  { id: "3323", name: "Camera Lenses" },
  { id: "11724", name: "Video Games & Consoles" },
  { id: "139971", name: "Video Game Consoles" },
  { id: "156955", name: "Video Games" },
  { id: "1249", name: "Video Game Controllers & Accessories" },
  { id: "14969", name: "TV, Video & Audio" },
  { id: "11071", name: "Televisions" },
  { id: "14977", name: "Home Audio" },
  { id: "50597", name: "Headphones" },
  { id: "15052", name: "Portable Audio & Headphones" },

  // Sporting Goods
  { id: "7294", name: "Fitness, Running & Yoga" },
  { id: "4", name: "Golf" },
  { id: "382", name: "Camping & Hiking" },
  { id: "1513", name: "Cycling" },
  { id: "64482", name: "Snowboarding" },
  { id: "36261", name: "Snow Sports" },
  { id: "7245", name: "Surfing" },
  { id: "50100", name: "Skateboarding" },
  { id: "36258", name: "Team Sports" },
  { id: "159049", name: "Basketball" },
  { id: "20849", name: "Baseball & Softball" },
  { id: "6047", name: "Soccer" },
  { id: "64505", name: "American Football" },
  { id: "159048", name: "Tennis" },

  // Outdoor/Work Wear
  { id: "175759", name: "Workwear & Uniforms" },
  { id: "57991", name: "Outdoor Clothing" },

  // Pens & Writing
  { id: "7279", name: "Other Collectible Ballpoint Pens" },
  { id: "7281", name: "Other Fountain Pens" },
  { id: "257906", name: "Ballpoint & Rollerball Pens" },
  { id: "967", name: "Other Collectible Pens" },
  { id: "14001", name: "Parker Pens" },
  { id: "29829", name: "Parker Fountain Pens" },
  { id: "552", name: "Art Drawings" },

  // Toys & Hobbies
  { id: "183446", name: "Action Figures" },
  { id: "2613", name: "Models & Kits" },
  { id: "19006", name: "Diecast & Toy Vehicles" },
  { id: "1196", name: "Stuffed Animals" },
  { id: "11731", name: "Puzzles" },
  { id: "2562", name: "Board Games" },
  { id: "64482", name: "LEGO Sets" },
  { id: "183454", name: "Trading Card Games" },

  // Collectibles
  { id: "49019", name: "Animation Art & Merchandise" },
  { id: "14339", name: "Coins" },
  { id: "262", name: "Coins & Paper Money" },
  { id: "237", name: "Stamps" },
  { id: "4", name: "Antiques" },
  { id: "20081", name: "Militaria" },
  { id: "1561", name: "Sports Trading Cards" },
  { id: "213", name: "Entertainment Memorabilia" },

  // Musical Instruments
  { id: "38080", name: "Guitars & Basses" },
  { id: "16220", name: "Pro Audio Equipment" },
  { id: "38083", name: "Keyboards & Pianos" },
  { id: "16221", name: "Brass" },
  { id: "16222", name: "Woodwind" },
  { id: "16224", name: "Drums & Percussion" },
  { id: "38084", name: "Amplifiers" },
  { id: "38086", name: "Guitar Parts & Accessories" },

  // Health & Beauty
  { id: "31786", name: "Fragrances" },
  { id: "45100", name: "Skin Care" },
  { id: "11848", name: "Hair Care & Styling" },
  { id: "67588", name: "Makeup" },
  { id: "36440", name: "Vitamins & Supplements" },
  { id: "67610", name: "Nail Care" },

  // Home & Garden
  { id: "20444", name: "Home Décor" },
  { id: "3197", name: "Kitchen, Dining & Bar" },
  { id: "36448", name: "Bedding" },
  { id: "60107", name: "Furniture" },
  { id: "159907", name: "Tools" },
  { id: "11804", name: "Gardening" },

  // Art
  { id: "551", name: "Paintings" },
  { id: "10015", name: "Photographs" },
  { id: "158964", name: "Prints" },
  { id: "7036", name: "Sculptures & Carvings" },

  // Books
  { id: "268", name: "Books" },
  { id: "74", name: "Music CDs" },
  { id: "617", name: "DVDs & Movies" },
]
