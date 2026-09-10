import { parseProspectRows } from '../../src/staff/import-rows'

describe('parseProspectRows — comma-separated files', () => {
  it('reads a plain CSV', () => {
    const { rows, errors } = parseProspectRows(
      'business_name,phone,location\nMama Ronke Kitchen,08031234567,Lagos\n',
    )
    expect(errors).toEqual([])
    expect(rows).toEqual([{
      businessName: 'Mama Ronke Kitchen',
      phone: '08031234567',
      instagramHandle: null,
      contactName: null,
      sourceDetail: null,
    }])
  })

  it('keeps a comma that lives inside a quoted field', () => {
    const { rows } = parseProspectRows('name,phone\n"Ronke Foods, Lekki",08031234567\n')
    expect(rows[0].businessName).toBe('Ronke Foods, Lekki')
  })

  it('handles a doubled quote inside a quoted field', () => {
    const { rows } = parseProspectRows('name,phone\n"Ronke ""The Chef"" Foods",08031234567\n')
    expect(rows[0].businessName).toBe('Ronke "The Chef" Foods')
  })
})

describe('parseProspectRows — spreadsheet paste', () => {
  it('reads tab-separated text, which is what a Sheets copy puts on the clipboard', () => {
    const { rows, errors } = parseProspectRows(
      'Name\tPhone\tIG\nBimpe Thrift\t08051234567\t@bimpethrift\n',
    )
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      businessName: 'Bimpe Thrift',
      phone: '08051234567',
      instagramHandle: 'bimpethrift',   // the @ is stripped
      contactName: null,
      sourceDetail: null,
    })
  })

  it('prefers tabs over commas so a name containing a comma still survives a paste', () => {
    // The failure this prevents: splitting on commas would turn one column into
    // two and shift every field after it.
    const { rows } = parseProspectRows('name\tphone\nRonke Foods, Lekki\t08031234567\n')
    expect(rows[0].businessName).toBe('Ronke Foods, Lekki')
    expect(rows[0].phone).toBe('08031234567')
  })
})

describe('parseProspectRows — headers', () => {
  it.each([
    ['phone'], ['Phone'], ['phone_number'], ['Phone Number'],
    ['number'], ['WhatsApp'], ['mobile'], ['tel'],
  ])('accepts %s as the phone column', (header) => {
    const { rows, errors } = parseProspectRows(`name,${header}\nA,08031234567\n`)
    expect(errors).toEqual([])
    expect(rows[0].phone).toBe('08031234567')
  })

  it.each([['business_name'], ['Business Name'], ['name'], ['company'], ['vendor']])(
    'accepts %s as the business name column', (header) => {
      const { rows } = parseProspectRows(`${header},phone\nRonke Foods,08031234567\n`)
      expect(rows[0].businessName).toBe('Ronke Foods')
    },
  )

  it('refuses a file with no phone column rather than importing blanks', () => {
    const { rows, errors, columns } = parseProspectRows('name,location\nRonke,Lagos\n')
    expect(rows).toEqual([])
    expect(errors[0].reason).toContain('no phone column')
    // Reported back so the console can show what it did recognise.
    expect(columns.businessName).toBe('name')
    expect(columns.phone).toBeNull()
  })

  it('ignores columns it does not know about', () => {
    const { rows, errors } = parseProspectRows(
      'name,phone,followers,rating\nRonke,08031234567,4200,4.8\n',
    )
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
  })
})

describe('parseProspectRows — bad input', () => {
  it('points at the line in the file, not at an index into the good rows', () => {
    // Blank lines are dropped but must not shift the reported line numbers,
    // because the user is looking at the original file.
    const { rows, errors } = parseProspectRows(
      'name,phone\nGood,08031234567\n\nBad,\n\nAlsoGood,08051234567\n',
    )
    expect(rows).toHaveLength(2)
    expect(errors).toEqual([{ line: 4, reason: 'no phone' }])
  })

  it('treats an empty paste as an error, not an empty import', () => {
    expect(parseProspectRows('   \n\n').errors[0].reason).toBe('nothing to import')
  })

  it('survives a row with fewer cells than the header', () => {
    const { rows, errors } = parseProspectRows('name,phone,contact\nRonke,08031234567\n')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ businessName: 'Ronke', contactName: null })
  })
})
