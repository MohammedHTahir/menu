const express = require('express');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const fs = require('fs');
const { UTApi } = require("uploadthing/server");

dotenv.config({ path: path.join(__dirname, '.env') });

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
  token: process.env.UPLOADTHING_TOKEN
});

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create a local storage solution
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// API endpoint for uploading files
app.post('/api/upload', upload.single('file'), async (req, res) => {
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
      // Save file to temporary location first
      const tempFilePath = path.join(uploadsDir, `temp-${Date.now()}-${req.file.originalname}`);
      fs.writeFileSync(tempFilePath, req.file.buffer);
      
      // Attempt to upload to UploadThing using UTApi and local file
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
    } catch (uploadThingError) {
      // If UploadThing fails, fall back to local storage
      console.log('[WARNING] UploadThing upload failed, falling back to local storage:', uploadThingError.message);
      
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

// Serve the index.html file for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the application at http://localhost:${PORT}`);
});