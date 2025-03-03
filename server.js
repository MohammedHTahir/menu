const express = require('express');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const fs = require('fs');
const { UTApi } = require("uploadthing/server");

// Load environment variables from .env file
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Log environment variables (without revealing full values)
console.log('[ENV] UPLOADTHING_TOKEN:', process.env.UPLOADTHING_TOKEN ? '***present***' : 'MISSING');

// Initialize UTApi with only the token
const utapi = new UTApi({
  apiKey: process.env.UPLOADTHING_TOKEN,
  fetch: require('node-fetch')
});

// Configure multer for file uploads (use memory storage for Vercel)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create uploads directory for local development 
// This won't work in Vercel's serverless environment
const isVercel = process.env.VERCEL === '1';
let uploadsDir = path.join(__dirname, 'uploads');

if (!isVercel && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// API endpoint for uploading files
app.post('/api/upload', upload.single('file'), async (req, res) => {
  console.log('[VERCEL DEBUG] API endpoint hit:', req.path);
  console.log('[VERCEL DEBUG] Environment:', process.env.VERCEL ? 'Vercel' : 'Local');
  console.log('[VERCEL DEBUG] Request method:', req.method);
  
  try {
    console.log('[DEBUG] Upload request received');
    
    if (!req.file) {
      console.error('[ERROR] No file uploaded');
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    console.log('[DEBUG] File metadata:', {
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });

    try {
      // For Vercel environment, we'll upload directly without temp file
      if (isVercel) {
        console.log('[DEBUG] Running in Vercel environment, uploading directly');
        
        const uploadResponse = await utapi.uploadFiles(
          [
            {
              file: req.file.buffer,
              fileName: req.file.originalname,
              contentType: req.file.mimetype
            }
          ]
        );
        
        console.log('[DEBUG] UploadThing response:', JSON.stringify(uploadResponse, null, 2));
        
        if (uploadResponse && uploadResponse[0]?.data?.url) {
          console.log('[SUCCESS] File uploaded to UploadThing:', uploadResponse[0].data.url);
          
          return res.status(200).json({
            success: true,
            fileUrl: uploadResponse[0].data.url
          });
        } else {
          throw new Error('No URL in UploadThing response');
        }
      } else {
        // For local development, use temp file method
        const tempFilePath = path.join(uploadsDir, `temp-${Date.now()}-${req.file.originalname}`);
        fs.writeFileSync(tempFilePath, req.file.buffer);
        
        console.log('[DEBUG] Starting UploadThing upload via UTApi');
        
        const uploadResponse = await utapi.uploadFiles({
          files: [
            {
              path: tempFilePath,
              name: req.file.originalname,
              type: req.file.mimetype,
            }
          ],
        });
        
        // Clean up temp file
        fs.unlinkSync(tempFilePath);
        
        console.log('[DEBUG] UploadThing response:', JSON.stringify(uploadResponse, null, 2));
        
        if (uploadResponse && uploadResponse[0]?.url) {
          console.log('[SUCCESS] File uploaded to UploadThing:', uploadResponse[0].url);
          
          return res.status(200).json({
            success: true,
            fileUrl: uploadResponse[0].url
          });
        } else {
          throw new Error('No URL in UploadThing response');
        }
      }
    } catch (uploadThingError) {
      // If UploadThing fails, fall back to local storage
      // This won't work in Vercel, so we'll need to handle differently
      console.log('[WARNING] UploadThing upload failed:', uploadThingError.message);
      
      if (isVercel) {
        try {
          // Instead of failing, let's create a data URL as a fallback
          console.log('[DEBUG] Creating data URL fallback in Vercel environment');
          
          // Create a base64 string from the buffer
          const base64Data = req.file.buffer.toString('base64');
          const mimeType = req.file.mimetype;
          const dataUrl = `data:${mimeType};base64,${base64Data}`;
          
          // Generate a unique identifier
          const timestamp = Date.now();
          const uniqueId = Math.random().toString(36).substring(2, 15);
          
          // Create a special URL that the frontend will understand as a data URL
          // We'll prefix it so the frontend knows to handle it differently
          const fallbackUrl = `/special-data-url/${timestamp}-${uniqueId}/${encodeURIComponent(req.file.originalname)}`;
          
          // Store the data URL in a global Map (in-memory cache)
          // This is temporary and will be lost when the serverless function exits
          // But it's good enough for immediate use
          if (!global.dataUrlCache) {
            global.dataUrlCache = new Map();
          }
          global.dataUrlCache.set(fallbackUrl, dataUrl);
          
          console.log('[SUCCESS] Created data URL fallback:', fallbackUrl);
          
          return res.status(200).json({
            success: true,
            fileUrl: fallbackUrl,
            isDataUrl: true
          });
        } catch (fallbackError) {
          console.error('[ERROR] Data URL fallback failed:', fallbackError);
          return res.status(500).json({
            success: false,
            error: 'Both UploadThing and data URL fallback failed'
          });
        }
      }
      
      // Generate a unique filename
      const timestamp = Date.now();
      const fileName = `${timestamp}-${req.file.originalname}`;
      const filePath = path.join(uploadsDir, fileName);
      
      // Save the file locally (if we haven't already)
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, req.file.buffer);
      }
      
      // Generate a URL for the saved file
      const fileUrl = `/uploads/${fileName}`;
      
      console.log('[SUCCESS] File saved locally as fallback:', fileUrl);
      
      return res.status(200).json({
        success: true,
        fileUrl: fileUrl,
        note: "Using local storage fallback"
      });
    }
  } catch (error) {
    console.error('[ERROR] Upload failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload file'
    });
  }
});

// Serve uploaded files (for local fallback)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Add this route to serve the data URLs
app.get('/special-data-url/:id/:filename', (req, res) => {
  const fullPath = `/special-data-url/${req.params.id}/${req.params.filename}`;
  
  if (global.dataUrlCache && global.dataUrlCache.has(fullPath)) {
    const dataUrl = global.dataUrlCache.get(fullPath);
    
    // Extract MIME type and base64 data
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const mimeType = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, 'base64');
      
      res.setHeader('Content-Type', mimeType);
      return res.send(buffer);
    }
  }
  
  return res.status(404).send('File not found or expired');
});

// Serve the index.html file for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server (only in non-Vercel environments)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
  });
}

// For Vercel, we need to export the Express app
module.exports = app;