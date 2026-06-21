import type { ProductResolution, ProductRow } from './types'

function normalizeTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(t\s?shirts?|tees?)\b/g, 'shirt')
    .replace(/\bshirts\b/g, 'shirt')
    .trim()
}

function variants(term: string): string[] {
  const normalized = normalizeTerm(term)
  const values = new Set([normalized])
  if (normalized.endsWith('s') && normalized.length > 3) values.add(normalized.slice(0, -1))
  if (!normalized.endsWith('s') && normalized.length > 2) values.add(`${normalized}s`)
  return [...values].filter(Boolean)
}

function synonyms(term: string): string[] {
  const normalized = normalizeTerm(term)
  if (/\b(pants?|trousers?|bottoms?|jeans?|chinos?|cargos?|joggers?)\b/.test(normalized)) {
    return ['pant', 'pants', 'trouser', 'trousers', 'bottom', 'bottoms', 'jean', 'jeans', 'chino', 'chinos', 'cargo', 'cargos', 'jogger', 'joggers']
  }
  if (/\b(tops?|shirts?|polo|polos|tees?|tshirts?|t shirts?|senator|ankara)\b/.test(normalized)) {
    return ['top', 'tops', 'shirt', 'shirts', 'polo', 'polos', 'tee', 'tees', 'tshirt', 'tshirts', 'senator', 'ankara']
  }
  if (/\b(shoes?|sneakers?|slides?|slippers?|sandals?|boots?|footwear)\b/.test(normalized)) {
    return ['shoe', 'shoes', 'sneaker', 'sneakers', 'slides', 'slide', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots', 'footwear']
  }
  return []
}

export class CatalogResolver {
  resolve(rawName: string, catalog: ProductRow[]): ProductResolution {
    const exactMatches = catalog.filter(product => product.active && this.productMatches(product, rawName))
    if (exactMatches.length === 1) {
      const product = exactMatches[0]
      return product.stockQuantity > 0 ? { type: 'exact', product } : { type: 'out_of_stock', product }
    }
    if (exactMatches.length > 1) {
      return { type: 'ambiguous', rawName, candidates: exactMatches.filter(product => product.stockQuantity > 0).slice(0, 6) }
    }

    const categoryMatches = this.categoryMatches(rawName, catalog)
    if (categoryMatches.length > 1) return { type: 'category', category: rawName, candidates: categoryMatches.slice(0, 6) }
    if (categoryMatches.length === 1) {
      const product = categoryMatches[0]
      return product.stockQuantity > 0 ? { type: 'exact', product } : { type: 'out_of_stock', product }
    }

    return { type: 'unknown', rawName }
  }

  categoryMatches(rawName: string, catalog: ProductRow[]): ProductRow[] {
    const targetTerms = new Set([...variants(rawName), ...synonyms(rawName)])
    if (targetTerms.size === 0) return []
    return catalog.filter(product => {
      if (!product.active || product.stockQuantity <= 0) return false
      const terms = [product.name, ...(product.aliases ?? [])].map(normalizeTerm)
      return terms.some(term => {
        if (targetTerms.has(term)) return true
        const words = new Set(term.split(/\s+/).filter(Boolean))
        return [...targetTerms].some(target => words.has(target))
      })
    })
  }

  productMatches(product: ProductRow, rawName: string): boolean {
    const target = normalizeTerm(rawName)
    if (!target) return false
    if (normalizeTerm(product.name) === target) return true
    return (product.aliases ?? []).some(alias => normalizeTerm(alias) === target)
  }

  categoryFromText(text: string, catalog: ProductRow[]): string | undefined {
    const normalized = ` ${normalizeTerm(text)} `
    for (const category of ['shoes', 'pants', 'tops']) {
      if (synonyms(category).some(alias => normalized.includes(` ${alias} `)) && this.categoryMatches(category, catalog).length > 0) {
        return category
      }
    }
    for (const product of catalog) {
      for (const term of [product.name, ...(product.aliases ?? [])]) {
        for (const word of normalizeTerm(term).split(/\s+/)) {
          if (word.length > 2 && normalized.includes(` ${word} `)) return word
        }
      }
    }
    return undefined
  }
}

