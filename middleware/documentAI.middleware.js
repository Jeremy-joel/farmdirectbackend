// ============================================================
// middleware/documentAI.middleware.js
// AI Document Verification using Claude Vision API
// Place this file in: Farm Direct v3 backend/middleware/
//
// Then update auth.routes.js to use it:
//   const { verifyDocument } = require('../middleware/documentAI.middleware');
//   router.post('/upload-document', verifyToken, docUpload.single('file'), verifyDocument, uploadDocument);
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');

// Prompts per document type
const PROMPTS = {
  idFront:`You are a document verification AI for a Kenyan marketplace.
Examine this image and determine if it is a valid Kenyan National ID card (front).
Check: Is this a real ID card (not blank paper, receipt, meme, screenshot, or random photo)?
Does it show ID features: photo, name, ID number? Is it clear enough to read?
Respond ONLY with this exact JSON format, no other text:
{"isValid":true,"confidence":0.95,"documentType":"kenyan_id_front","issues":[],"recommendation":"approve"}
recommendation must be: "approve", "reject", or "manual_review"`,

  idBack:`You are a document verification AI for a Kenyan marketplace.
Examine this image and determine if it is the BACK of a Kenyan National ID.
Check: Is this the back of a National ID (not blank paper or wrong document)?
Does it show a barcode or back fields? Is it clear?
Respond ONLY with this exact JSON:
{"isValid":true,"confidence":0.95,"documentType":"kenyan_id_back","issues":[],"recommendation":"approve"}`,

  selfie:`You are a document verification AI for a Kenyan marketplace.
Examine this image and determine if it is a valid selfie for identity verification.
Check: Is there a real human face clearly visible? Is the person facing the camera?
Is the image clear and well-lit? Is it a genuine selfie (not a photo of a photo, cartoon, or AI face)?
Respond ONLY with this exact JSON:
{"isValid":true,"confidence":0.95,"documentType":"selfie","issues":[],"recommendation":"approve"}`,

  licence:`You are a document verification AI for a Kenyan marketplace.
Examine this image and determine if it is a valid Kenyan Driving Licence.
Check: Is this actually a driving licence (not a blank paper or receipt)?
Does it show licence features: photo, name, licence number? Is it clear?
Respond ONLY with this exact JSON:
{"isValid":true,"confidence":0.95,"documentType":"driving_licence","issues":[],"recommendation":"approve"}`,

  vehicle:`You are a document verification AI for a Kenyan marketplace.
Examine this image and determine if it is a real photo of a delivery vehicle.
Check: Is there a visible real vehicle (motorcycle, van, pickup, etc.)?
Is this a genuine photo (not a stock image or cartoon)?
Respond ONLY with this exact JSON:
{"isValid":true,"confidence":0.95,"documentType":"vehicle","issues":[],"recommendation":"approve"}`,
};

const REJECTION_MESSAGES = {
  blank:          'The uploaded image appears blank or empty. Please upload a clear photo of your document.',
  unclear:        'The image is too blurry or dark. Please take a clearer photo in good lighting.',
  wrong_document: 'This does not appear to be the correct document. Please upload the right document.',
  no_face:        'No face is visible. Please take a clear selfie facing the camera.',
  multiple_faces: 'Multiple faces detected. Please take a selfie with only yourself visible.',
  photo_of_photo: 'Please upload an original photo, not a photo of another photo or screen.',
  stock_photo:    'This appears to be a stock image. Please upload a real photo of your vehicle.',
  no_vehicle:     'No vehicle is visible. Please upload a clear photo of your actual vehicle.',
  other:          'Document verification failed. Please upload a clear, genuine document photo.',
};

const verifyDocument = async (req, res, next) => {
  // Skip if no API key configured
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[DocumentAI] ANTHROPIC_API_KEY not set — skipping AI check');
    return next();
  }
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const docType = req.body.docType;
  const prompt  = PROMPTS[docType];

  // Unknown doc type — skip AI, let upload controller validate
  if (!prompt) return next();

  try {
    const client      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const base64Image = req.file.buffer.toString('base64');
    const mimeType    = req.file.mimetype || 'image/jpeg';

    console.log(`[DocumentAI] Verifying ${docType} for user ${req.user?.userId}`);

    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const text = response.content[0]?.text || '';
    let aiResult = null;

    try {
      const match = text.match(/\{[\s\S]*\}/);
      aiResult    = match ? JSON.parse(match[0]) : null;
    } catch(e) {
      console.warn('[DocumentAI] Could not parse AI response — allowing upload');
      return next();
    }

    if (!aiResult) return next();

    console.log(`[DocumentAI] ${docType} result:`, JSON.stringify(aiResult));

    // Attach to request for logging in upload controller
    req.aiVerification = aiResult;

    // Reject only when AI is confident (>= 75%) this is NOT a valid document
    if (aiResult.recommendation === 'reject' && aiResult.confidence >= 0.75) {
      const msgKey    = aiResult.documentType || 'other';
      const userMsg   = REJECTION_MESSAGES[msgKey] || REJECTION_MESSAGES.other;
      return res.status(400).json({
        success:   false,
        error:     userMsg,
        code:      'DOCUMENT_REJECTED',
        aiDetails: { documentType: aiResult.documentType, confidence: aiResult.confidence, issues: aiResult.issues || [] },
      });
    }

    // Flag for manual review
    if (aiResult.recommendation === 'manual_review') {
      req.requiresManualReview = true;
      req.aiIssues = aiResult.issues || [];
    }

    next(); // Document passed — proceed to upload

  } catch (error) {
    // AI service error — do NOT block user, just log and continue
    console.error('[DocumentAI] Service error (allowing upload):', error.message);
    next();
  }
};

module.exports = { verifyDocument };