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

// POST /api/upload - Accept PDF or image, convert to base64 page images
app.post('/api/upload', upload.single('document'), async (req, res) => {
  const startTime = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const pages = [];

    if (req.file.mimetype === 'application/pdf') {
      const pdfBuffer = fs.readFileSync(filePath);
      const document = await pdf(pdfBuffer, { scale: 2 });

      let pageNumber = 1;
      for await (const image of document) {
        const base64 = Buffer.from(image).toString('base64');
        pages.push({ pageNumber, base64, mediaType: 'image/png' });
        pageNumber++;
      }
    } else {
      // Image file — detect media type from mimetype
      const imageBuffer = fs.readFileSync(filePath);
      const base64 = imageBuffer.toString('base64');
      const mediaType = req.file.mimetype === 'image/jpg' ? 'image/jpeg' : req.file.mimetype;
      pages.push({ pageNumber: 1, base64, mediaType });
    }

    // Clean up temp file
    fs.unlinkSync(filePath);

    const processingTime = Date.now() - startTime;

    res.json({
      pages,
      pageCount: pages.length,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      processingTime,
    });
  } catch (error) {
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process file', details: error.message });
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
