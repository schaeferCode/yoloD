import express from 'express'
import bodyParser from 'body-parser'
import {
  Configuration,
  CountryCode,
  Holding,
  LinkTokenCreateRequest,
  PlaidApi,
  PlaidEnvironments,
  Products
} from 'plaid'
import crypto from 'crypto'
import 'dotenv/config'
import cors from 'cors'

const app = express()
const port = 3000

// Middleware
app.use(cors())
app.use(bodyParser.json())

// Plaid Configuration
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID
const PLAID_SECRET = process.env.PLAID_SECRET
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox' // Use "development" or "production" for live

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.log('something is wrong')
  process.exit()
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET
    }
  }
})
const plaidClient = new PlaidApi(plaidConfig)

const SECRET_KEY = 'my-very-secure-random-string' // Replace with a secure, randomly generated key

// Routes

app.post('/api/create_link_token', async function (req, res) {
  // Get the client_user_id by searching for the current user
  const request: LinkTokenCreateRequest = {
    user: {
      // This should correspond to a unique id for the current user.
      client_user_id: 'clientUserId'
    },
    client_name: 'Plaid Test App',
    products: [Products.Investments],
    language: 'en',
    // redirect_uri: 'http://localhost:5173/',
    country_codes: [CountryCode.Us]
  }
  try {
    const createTokenResponse = await plaidClient.linkTokenCreate(request)
    res.json(createTokenResponse.data)
  } catch (error) {
    console.log({ error })
    res.status(500)
  }
})

// Retrieve Holdings for an Item
// https://plaid.com/docs/#investments
app.post('/api/holdings', async function (req, res) {
  try {
    const pubToken: string = req.body.public_token
    const tokenResponse = await plaidClient.itemPublicTokenExchange({
      public_token: pubToken
    })

    const accessToken = tokenResponse.data.access_token

    const holdingsResponse = await plaidClient.investmentsHoldingsGet({
      access_token: accessToken
    })

    res.json(holdingsResponse.data)
  } catch (error) {
    console.log({ error })
    res.status(500)
  }
})

// Generate a signed table
app.post('/api/generate-signature', async (req, res) => {
  try {
    const tableData = req.body as (Holding & {
      ticker_symbol?: string | null
    })[]
    const digestData = tableData.map(
      ({ ticker_symbol, quantity, cost_basis }) => ({
        ticker_symbol: ticker_symbol || 'N/A',
        quantity: quantity.toFixed(0),
        cost_basis: cost_basis?.toFixed(2)
      })
    )
    console.log({ digestData })
    // Sign the table
    const hmac = crypto.createHmac('sha1', SECRET_KEY)
    hmac.update(JSON.stringify(digestData))
    const signature = hmac.digest('base64')

    res.json({ signature })
  } catch (error) {
    console.error('Error generating table:', error)
    res.status(500).json({ error: 'Failed to generate table' })
  }
})

// Verify a signed table
app.post('/api/verify-table', async (req, res) => {
  try {
    const { data } = req.body as { data: string }

    if (!data) {
      res.status(400).json({ message: 'No data provided' })
      return
    }

    const dataWithoutBorder = data.replace(/\*/g, '')

    const lines: string[] = dataWithoutBorder.split('\n')

    // Extract the signature
    const signatureLine = lines.find((line) => line.startsWith('signed:'))
    if (!signatureLine) {
      res.status(400).json({ message: 'No signature found' })
      return
    }
    const signature = signatureLine.replace('signed:', '').trim()

    // Find the table header and the rows
    const tableStartIndex = 1
    const tableEndIndex = lines.length - 1
    const tableLines = lines.slice(tableStartIndex + 2, tableEndIndex)

    // Extract the headers
    const headerLine = lines[tableStartIndex].trim()
    const headers = headerLine.split('|').map((header) => header.trim())

    const thing: Record<string, string> = {
      'Cost Basis': 'cost_basis',
      Security: 'ticker_symbol',
      Quantity: 'quantity'
    }

    // Parse the rows into objects
    const dataObjects = tableLines
      .filter((line) => line.trim()) // Skip empty lines
      .map((line) => {
        const values = line.split('|').map((value) => value.trim())
        return headers.reduce(
          (obj, header, index) => {
            obj[thing[header]] = values[index].replace('$', '')
            return obj
          },
          {} as Record<string, string>
        )
      })
    console.log({ dataObjects })
    const hmac = crypto.createHmac('sha1', SECRET_KEY)
    hmac.update(JSON.stringify(dataObjects))
    const newSig = hmac.digest('base64')
    console.log({ newSig })

    const isValid = newSig === signature

    // Respond with parsed data
    res.json({ isValid })
    return
  } catch (error) {
    res.status(500).json({ message: 'Internal Server Error', error })
    return
  }
})

// Start the server
app.listen(port, () => {
  console.log(`API running at http://localhost:${port}`)
})
