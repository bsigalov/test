import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists (temp only — files are deleted after processing)
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Clean up any leftover files from previous crashes on startup
const staleFiles = fs.readdirSync(uploadsDir);
for (const file of staleFiles) {
  fs.unlinkSync(path.join(uploadsDir, file));
}
if (staleFiles.length > 0) {
  console.log(`Cleaned up ${staleFiles.length} stale file(s) from uploads/`);
}

// Initialize Anthropic client
const anthropic = new Anthropic();

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Max base64 size for Claude Vision API (5MB raw = ~3.75MB base64 threshold to be safe)
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB base64 target (~3MB raw)

/**
 * Compress an image buffer so its base64 representation stays under Claude's 5MB limit.
 * Progressively reduces quality and resolution until it fits.
 */
async function compressImage(buffer, mediaType) {
  let base64 = buffer.toString('base64');

  // Already under limit — return as-is
  if (base64.length <= MAX_IMAGE_BYTES) {
    return { base64, mediaType };
  }

  console.log(`Image too large (${(base64.length / 1024 / 1024).toFixed(1)}MB base64), compressing...`);

  // Convert to JPEG for best compression, try progressively lower quality/size
  const attempts = [
    { width: 2048, quality: 85 },
    { width: 1600, quality: 80 },
    { width: 1200, quality: 75 },
    { width: 1024, quality: 70 },
    { width: 800, quality: 60 },
  ];

  for (const { width, quality } of attempts) {
    const compressed = await sharp(buffer)
      .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    base64 = compressed.toString('base64');

    if (base64.length <= MAX_IMAGE_BYTES) {
      console.log(`  Compressed to ${(base64.length / 1024 / 1024).toFixed(1)}MB (${width}px, q${quality})`);
      return { base64, mediaType: 'image/jpeg' };
    }
  }

  // Last resort — very aggressive
  const tiny = await sharp(buffer)
    .resize(640, undefined, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 50, mozjpeg: true })
    .toBuffer();

  base64 = tiny.toString('base64');
  console.log(`  Final compression: ${(base64.length / 1024 / 1024).toFixed(1)}MB (640px, q50)`);
  return { base64, mediaType: 'image/jpeg' };
}

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
          const rawBuffer = Buffer.from(image);
          const compressed = await compressImage(rawBuffer, 'image/png');
          pages.push({ pageNumber, base64: compressed.base64, mediaType: compressed.mediaType, sourceFile: file.originalname });
          pageNumber++;
        }
      } else {
        const imageBuffer = fs.readFileSync(filePath);
        const mediaType = file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype;
        const compressed = await compressImage(imageBuffer, mediaType);
        pages.push({ pageNumber, base64: compressed.base64, mediaType: compressed.mediaType, sourceFile: file.originalname });
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

// Common extraction instructions
const EXTRACTION_COMMON = `
IMPORTANT: This document is in Hebrew (עברית). Read all Hebrew text carefully from right to left.
Transliterate Hebrew names to English/Latin characters where possible.
For dates, use the format DD.MM.YYYY as printed.
For fields you cannot read or find, return null.`;

// Data extraction prompts per document type
const EXTRACTION_PROMPTS = {
  ID_CARD: `Extract the following fields from this Israeli biometric ID card (תעודת זהות ביומטרית).
The card has Hebrew text on the front with a photo, and may have English transliteration on the back.
${EXTRACTION_COMMON}

Fields to extract:
- id_number: The 9-digit ID number (מספר זהות) — usually at the top
- first_name: Given name (שם פרטי) — read Hebrew, transliterate to Latin
- last_name: Family name (שם משפחה) — read Hebrew, transliterate to Latin
- date_of_birth: (תאריך לידה) — format DD.MM.YYYY
- date_of_issue: (תאריך הנפקה) — format DD.MM.YYYY
- date_of_expiry: (תוקף) — format DD.MM.YYYY
- gender: (מין) — "male"/"female" (זכר/נקבה)
- place_of_birth: (מקום לידה) if visible`,

  ID_CARD_APPENDIX: `Extract fields from this Israeli ID appendix (ספח תעודת זהות / נספח).
This is a folded paper document listing personal info, address, family members.
Text is printed in Hebrew. Look for sections with כתובת (address), מצב אישי (marital status), etc.
${EXTRACTION_COMMON}

Fields to extract:
- id_number: 9-digit ID number (מספר זהות)
- full_name: Full name (שם מלא) — transliterate Hebrew to Latin
- address: Street and house number (כתובת - רחוב ומספר)
- city: City name (עיר/ישוב)
- marital_status: (מצב אישי) — e.g. נשוי=married, רווק=single, גרוש=divorced
- spouse_name: Spouse name (שם בן/בת זוג) — transliterate to Latin
- children: Array of children with names and birth dates if visible`,

  PASSPORT: `Extract fields from this passport. May be Israeli (דרכון ישראלי) or international.
Look for MRZ (machine-readable zone) at the bottom for accurate data.
${EXTRACTION_COMMON}

Fields to extract:
- passport_number
- first_name
- last_name
- nationality
- date_of_birth (DD.MM.YYYY)
- date_of_issue (DD.MM.YYYY)
- date_of_expiry (DD.MM.YYYY)
- issuing_country`,

  DRIVERS_LICENSE: `Extract fields from this Israeli driving license (רישיון נהיגה).
The card has Hebrew text with the driver's photo. Look for license number, personal details, and categories.
${EXTRACTION_COMMON}

Fields to extract:
- license_number: (מספר רישיון) — numeric
- first_name: (שם פרטי) — transliterate Hebrew to Latin
- last_name: (שם משפחה) — transliterate Hebrew to Latin
- date_of_birth: (תאריך לידה) — DD.MM.YYYY
- date_of_issue: (תאריך הנפקה) — DD.MM.YYYY
- date_of_expiry: (תוקף) — DD.MM.YYYY
- license_categories: (דרגות) — e.g. A, B, C, D`,

  VEHICLE_LICENSE: `Extract fields from this Israeli vehicle registration certificate (רישיון רכב).
This is a card/paper with vehicle details in Hebrew. Look for מספר רכב (plate), סוג (type), יצרן (manufacturer).
${EXTRACTION_COMMON}

Fields to extract:
- license_plate: Vehicle plate number (מספר רכב) — digits only
- vehicle_type: (סוג רכב) — e.g. "פרטי נוסעים M1"
- manufacturer: (יצרן/שם מסחרי) — e.g. פיג'ו, טויוטה, etc.
- model: (דגם) — model name
- year: (שנת ייצור) — 4-digit year
- color: (צבע) if visible
- owner_name: (שם בעלים) — transliterate Hebrew to Latin
- owner_id: (ת.ז. בעלים) — 9-digit ID
- validity_date: (תוקף) — DD/MM/YYYY
- engine_volume: (נפח מנוע) if visible`,

  BANK_STATEMENT: `Extract fields from this Israeli bank statement (דף חשבון בנק).
Common Israeli banks: הפועלים (Hapoalim), לאומי (Leumi), דיסקונט (Discount), מזרחי טפחות (Mizrahi Tefahot).
Look for bank logo, account details header, and balance summary.
${EXTRACTION_COMMON}

Fields to extract:
- bank_name: Full bank name in English (e.g. "Bank Hapoalim", "Bank Leumi")
- branch_number: (סניף) — typically 3 digits
- account_number: (חשבון) — account number
- account_holder_name: (שם בעל החשבון) — transliterate to Latin
- statement_period: From-to dates (תקופה)
- opening_balance: (יתרת פתיחה) — number with no currency symbol
- closing_balance: (יתרת סגירה) — number
- currency: ILS/USD/EUR as applicable`,

  SALARY_SLIP: `Extract fields from this Israeli salary slip (תלוש שכר / תלוש משכורת).
Look for employer name at top, employee details, and salary breakdown table.
${EXTRACTION_COMMON}

Fields to extract:
- employer_name: (שם מעסיק/חברה) — transliterate to Latin
- employee_name: (שם עובד) — transliterate to Latin
- employee_id: (ת.ז.) — 9-digit ID
- month_year: (חודש שכר) — MM/YYYY
- gross_salary: (שכר ברוטו) — number
- net_salary: (שכר נטו / לתשלום) — number
- deductions_total: (סה"כ ניכויים) — number
- employer_deductions: (הפרשות מעסיק) — number if visible`,

  TAX_DOCUMENT: `Extract fields from this Israeli tax document.
May be: טופס 106 (annual employer tax report), שומת מס (tax assessment), אישור ניכוי מס (tax deduction cert).
${EXTRACTION_COMMON}

Fields to extract:
- document_type: Type name (e.g. "Tofes 106", "Tax Assessment")
- tax_year: (שנת מס) — 4-digit year
- taxpayer_name: — transliterate to Latin
- taxpayer_id: (ת.ז./ח.פ.) — ID number
- total_income: (הכנסה כוללת/ברוטו שנתי) — number
- total_tax_paid: (מס שנוכה/מס ששולם) — number`,

  UTILITY_BILL: `Extract fields from this utility bill (חשבון חשמל/מים/גז/ארנונה).
May be from Israeli utilities: חברת חשמל, מקורות, עיריה (arnona), etc.
${EXTRACTION_COMMON}

Fields to extract:
- provider_name: Company/municipality name
- account_number: (מספר חשבון/מספר לקוח)
- bill_date: (תאריך חשבון) — DD.MM.YYYY
- bill_period: (תקופת חיוב)
- amount_due: (לתשלום) — number
- account_holder_name: — transliterate to Latin
- service_address: (כתובת הנכס) — transliterate to Latin`,

  PROOF_OF_ADDRESS: `Extract fields from this proof of address document.
May be: אישור כתובת from municipality, bank letter, or utility confirmation.
${EXTRACTION_COMMON}

Fields to extract:
- full_name: — transliterate to Latin
- address: Street and number
- city: City/town name
- date_issued: DD.MM.YYYY
- issuing_authority: Who issued it`,

  EMPLOYMENT_LETTER: `Extract fields from this employment letter (אישור העסקה).
Typically issued by employer on company letterhead confirming employment details.
${EXTRACTION_COMMON}

Fields to extract:
- employer_name: Company name — transliterate to Latin
- employee_name: — transliterate to Latin
- employee_id: (ת.ז.) — 9-digit ID
- position: (תפקיד) — job title
- start_date: (תאריך תחילת העסקה) — DD.MM.YYYY
- salary: Monthly salary if mentioned — number
- letter_date: Date of the letter — DD.MM.YYYY`,

  OTHER: `Extract any identifiable fields from this document.
The document may be in Hebrew (עברית) or English.
${EXTRACTION_COMMON}

Fields to extract:
- document_title: What type of document this appears to be
- names: Any person/company names found — transliterate Hebrew to Latin
- dates: Any dates found
- reference_numbers: Any ID/reference/account numbers
- amounts: Any monetary amounts with currency`,
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

// POST /api/summarize - Generate LLM summary of all documents and extracted data
app.post('/api/summarize', async (req, res) => {
  const startTime = Date.now();

  try {
    const { documents, extractedData } = req.body;

    if (!documents || !documents.length) {
      return res.status(400).json({ error: 'No documents provided' });
    }

    // Build a text description of all documents and their extracted data
    const docSummaries = documents.map((doc, i) => {
      const data = extractedData[i];
      const dataStr = data && !data.error
        ? Object.entries(data).map(([k, v]) => `  ${k}: ${v === null ? 'N/A' : typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
        : '  (no data extracted)';
      return `Document ${i + 1}: ${doc.type} (${doc.pages.length} page(s), pages: ${doc.pages.map(p => p.page).join(', ')})\n${dataStr}`;
    }).join('\n\n');

    const summaryPrompt = `You are analyzing the results of an automated loan document classification and data extraction POC (Proof of Concept).

Below are the documents that were uploaded, classified, and had data extracted from them:

${docSummaries}

Please provide a structured analysis with these two sections:

## Product Capability Summary
Summarize what the system successfully accomplished:
- How many documents were classified, what types were identified
- What personal/financial data was extracted from each document type
- What practical loan processing workflows this enables (e.g. identity verification, income verification, asset verification)
- Highlight any cross-document insights (e.g. matching names/IDs across documents, income vs. bank balance)

## POC Accuracy & Productivity Analysis
Evaluate the quality of the extraction results:
- Which fields were extracted successfully vs. returned null/empty
- Calculate an overall extraction success rate (fields with values / total fields)
- Estimate time savings compared to manual data entry (assume ~2 min per document manual vs. automated)
- Flag any data quality concerns (mismatched formats, incomplete data, potential misreads)
- Provide a 1-5 rating for: Classification Accuracy, Extraction Completeness, Production Readiness

Keep the response concise but insightful. Use bullet points. Write in English.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: summaryPrompt }],
    });

    const summary = response.content[0].text;
    const processingTime = Date.now() - startTime;

    res.json({
      summary,
      processingTime,
      model: response.model,
      usage: response.usage,
    });
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: 'Summary generation failed', details: error.message });
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
