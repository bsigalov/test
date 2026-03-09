import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { pdf } from 'pdf-to-img';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// Initialize Anthropic client
const anthropic = new Anthropic();

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer configuration
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Classification prompt
const CLASSIFICATION_PROMPT = `Analyze these scanned document pages from a loan application.

For each page, identify the document type from this list:
- ID_CARD (Israeli Teudat Zehut - main biometric card)
- ID_CARD_APPENDIX (Sefach / נספח לתעודת זהות - the folded paper appendix that lists family members and address)
- PASSPORT
- DRIVERS_LICENSE (רישיון נהיגה - driving license)
- VEHICLE_LICENSE (רישיון רכב - vehicle registration / ownership certificate)
- BANK_STATEMENT
- SALARY_SLIP (Tlush Sachar)
- TAX_DOCUMENT (Tofes 106, Shuma, etc.)
- UTILITY_BILL
- PROOF_OF_ADDRESS
- EMPLOYMENT_LETTER
- OTHER

Return ONLY a JSON array with no additional text:
[
  { "page": 1, "type": "ID_CARD", "isFirstPage": true, "confidence": "high" },
  { "page": 2, "type": "BANK_STATEMENT", "isFirstPage": true, "confidence": "high" },
  { "page": 3, "type": "BANK_STATEMENT", "isFirstPage": false, "confidence": "medium" }
]

Rules:
- Set isFirstPage=true when a NEW document starts
- Set isFirstPage=false for continuation pages of the same document
- confidence: "high", "medium", or "low"
- Detect document boundaries by visual layout changes`;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/upload - Accept multiple PDF or image files, convert to base64 page images
app.post('/api/upload', upload.array('documents', 20), async (req, res) => {
  const startTime = Date.now();
  const filesToClean = [];

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const pages = [];
    let pageNumber = 1;
    const fileDetails = [];

    for (const file of req.files) {
      filesToClean.push(file.path);
      const filePath = file.path;

      if (file.mimetype === 'application/pdf') {
        const pdfBuffer = fs.readFileSync(filePath);
        const document = await pdf(pdfBuffer, { scale: 2 });

        for await (const image of document) {
          const base64 = Buffer.from(image).toString('base64');
          pages.push({ pageNumber, base64, mediaType: 'image/png', sourceFile: file.originalname });
          pageNumber++;
        }
      } else {
        const imageBuffer = fs.readFileSync(filePath);
        const base64 = imageBuffer.toString('base64');
        const mediaType = file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype;
        pages.push({ pageNumber, base64, mediaType, sourceFile: file.originalname });
        pageNumber++;
      }

      fileDetails.push({ name: file.originalname, size: file.size, type: file.mimetype });
    }

    // Clean up temp files
    for (const fp of filesToClean) {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    const processingTime = Date.now() - startTime;

    res.json({
      pages,
      pageCount: pages.length,
      fileCount: req.files.length,
      files: fileDetails,
      processingTime,
    });
  } catch (error) {
    for (const fp of filesToClean) {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process files', details: error.message });
  }
});

// POST /api/classify - Send page images to Claude for classification
app.post('/api/classify', async (req, res) => {
  const startTime = Date.now();

  try {
    const { pages } = req.body;

    if (!pages || !pages.length) {
      return res.status(400).json({ error: 'No pages provided' });
    }

    // Build content array with all page images
    const content = pages.map((page) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: page.mediaType || 'image/png',
        data: page.base64 || page,
      },
    }));

    // Add classification prompt
    content.push({
      type: 'text',
      text: CLASSIFICATION_PROMPT,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    });

    const rawText = response.content[0].text;

    // Strip markdown fences if present
    const jsonText = rawText
      .replace(/^```json\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    const classifications = JSON.parse(jsonText);

    const processingTime = Date.now() - startTime;

    res.json({
      classifications,
      rawResponse: rawText,
      processingTime,
      model: response.model,
      usage: response.usage,
    });
  } catch (error) {
    console.error('Classification error:', error);
    res.status(500).json({ error: 'Classification failed', details: error.message });
  }
});

// Data extraction prompts per document type
const EXTRACTION_PROMPTS = {
  ID_CARD: `Extract the following fields from this Israeli ID card (Teudat Zehut):
- id_number (מספר זהות)
- first_name (שם פרטי)
- last_name (שם משפחה)
- date_of_birth (תאריך לידה)
- date_of_issue (תאריך הנפקה)
- date_of_expiry (תאריך תפוגה)
- gender (מין)`,
  ID_CARD_APPENDIX: `Extract the following fields from this Israeli ID appendix (Sefach / נספח):
- id_number (מספר זהות)
- full_name (שם מלא)
- address (כתובת)
- city (עיר)
- marital_status (מצב משפחתי)
- spouse_name (שם בן/בת זוג)
- children (list of children names and birth dates if visible)`,
  PASSPORT: `Extract the following fields from this passport:
- passport_number
- first_name
- last_name
- nationality
- date_of_birth
- date_of_issue
- date_of_expiry
- issuing_country`,
  DRIVERS_LICENSE: `Extract the following fields from this driving license:
- license_number
- first_name
- last_name
- date_of_birth
- date_of_issue
- date_of_expiry
- license_categories`,
  VEHICLE_LICENSE: `Extract the following fields from this vehicle license (רישיון רכב):
- license_plate (מספר רכב)
- vehicle_type (סוג רכב)
- manufacturer (יצרן)
- model (דגם)
- year (שנת ייצור)
- owner_name (שם בעלים)
- owner_id (ת.ז. בעלים)
- validity_date (תוקף)`,
  BANK_STATEMENT: `Extract the following fields from this bank statement:
- bank_name
- branch_number
- account_number
- account_holder_name
- statement_period (from-to dates)
- opening_balance
- closing_balance
- currency`,
  SALARY_SLIP: `Extract the following fields from this salary slip (Tlush Sachar):
- employer_name (שם מעסיק)
- employee_name (שם עובד)
- employee_id (ת.ז.)
- month_year (חודש/שנה)
- gross_salary (שכר ברוטו)
- net_salary (שכר נטו)
- deductions_total (סה"כ ניכויים)`,
  TAX_DOCUMENT: `Extract the following fields from this tax document:
- document_type (e.g. Tofes 106, Shuma)
- tax_year
- taxpayer_name
- taxpayer_id
- total_income
- total_tax_paid`,
  UTILITY_BILL: `Extract the following fields from this utility bill:
- provider_name
- account_number
- bill_date
- bill_period
- amount_due
- account_holder_name
- service_address`,
  PROOF_OF_ADDRESS: `Extract the following fields from this proof of address document:
- full_name
- address
- city
- date_issued
- issuing_authority`,
  EMPLOYMENT_LETTER: `Extract the following fields from this employment letter:
- employer_name
- employee_name
- employee_id
- position/role
- start_date
- salary (if mentioned)
- letter_date`,
  OTHER: `Extract any identifiable fields from this document, including:
- document_title or type
- names
- dates
- reference numbers
- any monetary amounts`,
};

// POST /api/extract - Extract data from a grouped document's pages
app.post('/api/extract', async (req, res) => {
  const startTime = Date.now();

  try {
    const { documentType, pages } = req.body;

    if (!pages || !pages.length) {
      return res.status(400).json({ error: 'No pages provided' });
    }

    const extractionPrompt = EXTRACTION_PROMPTS[documentType] || EXTRACTION_PROMPTS.OTHER;

    const content = pages.map((page) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: page.mediaType || 'image/png',
        data: page.base64,
      },
    }));

    content.push({
      type: 'text',
      text: `${extractionPrompt}

Return ONLY a JSON object with the extracted fields. Use null for fields you cannot read or find.
Do not include any explanation or markdown formatting — just the raw JSON object.`,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    });

    const rawText = response.content[0].text;
    const jsonText = rawText
      .replace(/^```json\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    const extractedData = JSON.parse(jsonText);
    const processingTime = Date.now() - startTime;

    res.json({
      extractedData,
      rawResponse: rawText,
      processingTime,
      model: response.model,
      usage: response.usage,
    });
  } catch (error) {
    console.error('Extraction error:', error);
    res.status(500).json({ error: 'Data extraction failed', details: error.message });
  }
});

// POST /api/save-documents - Simulate saving grouped documents
app.post('/api/save-documents', (req, res) => {
  const { documents } = req.body;

  if (!documents || !documents.length) {
    return res.status(400).json({ error: 'No documents provided' });
  }

  console.log('\n=== Saving Documents ===');
  documents.forEach((doc, index) => {
    console.log(
      `Document ${index + 1}: ${doc.type} (${doc.pages.length} pages: ${doc.pages.map((p) => p.page).join(', ')})`
    );
  });
  console.log(`Total: ${documents.length} documents\n`);

  res.json({
    success: true,
    documentCount: documents.length,
    message: `Successfully saved ${documents.length} documents`,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  console.log(`Document Classifier POC running at http://localhost:${PORT}`);
});
