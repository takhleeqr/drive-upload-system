const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
    MAIN_FOLDER_ID: '1oN7WEEVfUnni6g20nyViajXEtGRW6Fp7',
    MAX_FILE_SIZE: 1024 * 1024 * 1024, // 1GB per file
    MAX_FILES: 10 // Maximum files per upload
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: CONFIG.MAX_FILE_SIZE,
        files: CONFIG.MAX_FILES
    }
});

// Initialize Google Drive API with service account
let driveService;

async function initializeDriveAPI() {
    try {
        // Parse the service account key from environment variable
        const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        
        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccountKey,
            scopes: ['https://www.googleapis.com/auth/drive']
        });
        
        const authClient = await auth.getClient();
        driveService = google.drive({ version: 'v3', auth: authClient });
        
        console.log('✅ Google Drive API initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Drive API:', error.message);
        return false;
    }
}

// Serve the upload panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get available models from Drive folder structure
app.get('/api/models', async (req, res) => {
    try {
        const response = await driveService.files.list({
            q: `'${CONFIG.MAIN_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            orderBy: 'name'
        });
        
        const models = response.data.files
            .map(folder => folder.name.trim())
            .filter(name => name && !name.startsWith('.') && !name.startsWith('_'))
            .sort();
        
        res.json({ success: true, models });
    } catch (error) {
        console.error('Error getting models:', error);
        // Return default models if Drive access fails
        res.json({ 
            success: true, 
            models: ['Amira', 'Noya', 'Mia', 'Jasmine', 'Thalia', 'Halima'] 
        });
    }
});

// Create folder structure
app.post('/api/create-folder-path', async (req, res) => {
    try {
        const { modelName, platform, category, scriptTitle } = req.body;
        
        if (!modelName || !platform || !category) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required folder path parameters' 
            });
        }
        
        const folderId = await getOrCreateFolderPath({
            modelName: modelName.trim(),
            platform,
            category: category.trim(),
            scriptTitle: scriptTitle ? scriptTitle.trim() : null
        });
        
        res.json({ success: true, folderId });
    } catch (error) {
        console.error('Error creating folder path:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Upload files endpoint
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const { folderId } = req.body;
        
        if (!folderId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Target folder ID required' 
            });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No files provided' 
            });
        }
        
        console.log(`Uploading ${req.files.length} files to folder ${folderId}`);
        
        const uploadPromises = req.files.map(file => uploadFileToDrive(file, folderId));
        const results = await Promise.all(uploadPromises);
        
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        
        res.json({
            success: failed.length === 0,
            results,
            summary: {
                total: results.length,
                successful: successful.length,
                failed: failed.length
            },
            message: failed.length === 0 ? 
                `All ${successful.length} files uploaded successfully!` : 
                `${successful.length} uploaded, ${failed.length} failed`
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Helper function to create folder path
async function getOrCreateFolderPath({ modelName, platform, category, scriptTitle }) {
    const folderPath = [];
    
    // Build folder path
    folderPath.push(modelName);
    folderPath.push(platform === 'of' ? 'OF Profile' : 
                   platform.charAt(0).toUpperCase() + platform.slice(1));
    folderPath.push(category);
    
    if (category === 'Scripts' && scriptTitle) {
        folderPath.push(scriptTitle);
    }
    
    // Create folder hierarchy
    let currentFolderId = CONFIG.MAIN_FOLDER_ID;
    
    for (const folderName of folderPath) {
        console.log(`Looking for folder: ${folderName}`);
        const existingFolder = await findFolder(currentFolderId, folderName);
        
        if (existingFolder) {
            currentFolderId = existingFolder.id;
            console.log(`Found existing folder: ${folderName}`);
        } else {
            const newFolder = await createFolder(folderName, currentFolderId);
            currentFolderId = newFolder.id;
            console.log(`Created new folder: ${folderName}`);
        }
    }
    
    return currentFolderId;
}

// Helper function to find folder by name
async function findFolder(parentId, name) {
    try {
        const response = await driveService.files.list({
            q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)'
        });
        
        return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
        console.error('Error finding folder:', error);
        return null;
    }
}

// Helper function to create folder
async function createFolder(name, parentId) {
    try {
        const response = await driveService.files.create({
            requestBody: {
                name: name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            },
            fields: 'id, name'
        });
        
        return response.data;
    } catch (error) {
        console.error('Error creating folder:', error);
        throw error;
    }
}

// Helper function to upload file to Drive
async function uploadFileToDrive(file, folderId) {
    try {
        console.log(`Uploading file: ${file.originalname} (${file.size} bytes)`);
        
        // Check if file already exists
        const existingFiles = await driveService.files.list({
            q: `name='${file.originalname}' and '${folderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });
        
        if (existingFiles.data.files.length > 0) {
            console.log(`File already exists: ${file.originalname}`);
            return {
                success: true,
                fileName: file.originalname,
                fileId: existingFiles.data.files[0].id,
                message: 'File already exists'
            };
        }
        
        const response = await driveService.files.create({
            requestBody: {
                name: file.originalname,
                parents: [folderId]
            },
            media: {
                mimeType: file.mimetype,
                body: require('stream').Readable.from(file.buffer)
            },
            fields: 'id, name, size'
        });
        
        console.log(`Successfully uploaded: ${file.originalname}`);
        
        return {
            success: true,
            fileName: file.originalname,
            fileId: response.data.id,
            size: file.size
        };
    } catch (error) {
        console.error(`Error uploading ${file.originalname}:`, error);
        return {
            success: false,
            fileName: file.originalname,
            error: error.message
        };
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                error: `File too large. Maximum size is ${CONFIG.MAX_FILE_SIZE / (1024*1024)}MB`
            });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                error: `Too many files. Maximum is ${CONFIG.MAX_FILES} files`
            });
        }
    }
    
    console.error('Server error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
async function startServer() {
    const driveInitialized = await initializeDriveAPI();
    
    if (!driveInitialized) {
        console.error('❌ Cannot start server without Google Drive API');
        process.exit(1);
    }
    
    app.listen(PORT, () => {
        console.log(`🚀 Upload server running on port ${PORT}`);
        console.log(`📁 Uploads will go to Google Drive folder: ${CONFIG.MAIN_FOLDER_ID}`);
    });
}

startServer();
