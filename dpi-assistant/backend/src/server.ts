import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai'; // New SDK with web search support
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { VectorStore } from './services/vectorStore';
import { EmbeddingService } from './utils/embeddings';
import { S3Service } from './services/s3Service';
import { SlackService } from './services/slackService';
import { IndexingService } from './services/indexingService';
import { extractTextFromPDF, isSupportedDocument, isPDF } from './utils/pdfExtractor';

// Load environment variables from parent directory (for local development)
// In Docker/production, environment variables are passed directly
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log('✅ Loaded environment variables from .env');
  }
}

const app = express();
const port = process.env.PORT || 8080;

// CORS configuration
const corsOptions = {
  origin: [
    'https://assistant.cdpi.dev',
    'http://assistant.cdpi.dev',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://3.6.69.157'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Define Slack webhook BEFORE any middleware (including CORS)
// This route needs raw body for signature verification and must bypass CORS
app.post('/slack/events', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Parse the body
    const rawBody = req.body.toString('utf8');
    const body = JSON.parse(rawBody);

    // Handle Slack URL verification challenge FIRST (before any service checks)
    if (body.type === 'url_verification') {
      console.log('✅ Slack URL verification challenge received');
      console.log('Challenge value:', body.challenge);

      // Respond with the challenge value - Slack accepts plain text or JSON
      // Using plain text for maximum compatibility
      return res.status(200).type('text/plain').send(body.challenge);
    }

    // Check services are configured for all other requests
    if (!slackService || !s3Service) {
      return res.status(503).json({ error: 'Slack or S3 service not configured' });
    }

    // Verify Slack signature for all other requests
    const slackSignature = req.headers['x-slack-signature'] as string;
    const slackTimestamp = req.headers['x-slack-request-timestamp'] as string;

    if (!slackService.verifySlackRequest(slackSignature, slackTimestamp, rawBody)) {
      console.warn('⚠️  Invalid Slack signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Handle file_shared event
    if (body.event?.type === 'file_shared') {
      const fileId = body.event.file_id;
      const channelId = body.event.channel_id;

      // Event deduplication - use event_id if available, otherwise use file_id + event_ts
      const eventId = body.event_id || `${fileId}_${body.event.event_ts}`;

      // Check if we've already processed this event
      if (processedEvents.has(eventId)) {
        console.log(`⏭️  Skipping duplicate event: ${eventId} (file: ${fileId})`);
        return res.json({ ok: true });
      }

      // Mark event as processed
      processedEvents.set(eventId, Date.now());

      // Only process files from the designated knowledge base channel
      if (slackChannelId && channelId !== slackChannelId) {
        console.log(`⏭️  Ignoring file from channel ${channelId} (not knowledge base channel)`);
        return res.json({ ok: true });
      }

      console.log(`📥 Processing file upload from Slack: ${fileId} (event: ${eventId})`);

      // Get file info
      const fileInfo = await slackService.getFileInfo(fileId);

      // Validate file type (must be markdown or PDF)
      if (!isSupportedDocument(fileInfo.name)) {
        await slackService.addReaction(channelId, body.event.event_ts, 'x');
        await slackService.postMessage(
          channelId,
          `❌ Only Markdown (.md) and PDF (.pdf) files are supported. File "${fileInfo.name}" was not added to the knowledge base.`
        );
        return res.json({ ok: true });
      }

      // Download file from Slack
      const fileBuffer = await slackService.downloadFile(fileInfo.url_private_download);

      // Upload to S3
      await s3Service.uploadFileBuffer(fileInfo.name, fileBuffer);

      // Add success reaction
      await slackService.addReaction(channelId, body.event.event_ts, 'white_check_mark');

      // Auto-index if indexing service is available
      if (indexingService) {
        let indexingSuccess = false;
        let lastError: any = null;
        const maxRetries = 3;
        const retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            console.log(`📝 Indexing attempt ${attempt + 1}/${maxRetries} for: ${fileInfo.name}`);

            // Extract text content based on file type
            let content: string;
            if (isPDF(fileInfo.name)) {
              console.log(`   Extracting text from PDF...`);
              content = await extractTextFromPDF(fileBuffer);
              console.log(`   ✅ Extracted ${content.length} characters from PDF`);
            } else {
              content = fileBuffer.toString('utf-8');
              console.log(`   ✅ Loaded ${content.length} characters from markdown`);
            }

            // Validate content
            if (!content || content.trim().length === 0) {
              throw new Error('Document content is empty after extraction');
            }

            console.log(`   Indexing document with ${content.length} characters...`);
            await indexingService.indexDocument(fileInfo.name, content);

            console.log(`✅ Successfully indexed "${fileInfo.name}" on attempt ${attempt + 1}`);
            indexingSuccess = true;
            break; // Success, exit retry loop
          } catch (indexError) {
            lastError = indexError;
            console.error(`❌ Indexing attempt ${attempt + 1} failed for "${fileInfo.name}":`, indexError);

            // Log detailed error information
            if (indexError instanceof Error) {
              console.error(`   Error name: ${indexError.name}`);
              console.error(`   Error message: ${indexError.message}`);
              console.error(`   Error stack: ${indexError.stack}`);
            }

            // If not the last attempt, wait before retrying
            if (attempt < maxRetries - 1) {
              const delay = retryDelays[attempt];
              console.log(`   ⏳ Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }

        // Send appropriate Slack message
        if (indexingSuccess) {
          await slackService.postMessage(
            channelId,
            `✅ Successfully added "${fileInfo.name}" to knowledge base and indexed for search!`
          );
        } else {
          // Extract error type for better error messages
          let errorType = 'Unknown error';
          let errorHint = 'Run manual re-index using: POST /reindex with {"fileName": "' + fileInfo.name + '"}';

          if (lastError instanceof Error) {
            if (lastError.message.includes('ECONNREFUSED') || lastError.message.includes('connect')) {
              errorType = 'Vector store connection failed';
              errorHint = 'Check if Qdrant is running: npm run qdrant:start';
            } else if (lastError.message.includes('API') || lastError.message.includes('quota') || lastError.message.includes('rate limit')) {
              errorType = 'API quota or rate limit exceeded';
              errorHint = 'Wait a few minutes and try manual re-index';
            } else if (lastError.message.includes('empty')) {
              errorType = 'Document content is empty';
              errorHint = 'Check if PDF extraction is working correctly';
            } else {
              errorType = lastError.message.substring(0, 100);
            }
          }

          console.error(`\n❌ All ${maxRetries} indexing attempts failed for "${fileInfo.name}"`);
          console.error(`   Error type: ${errorType}`);
          console.error(`   Full error:`, lastError);

          await slackService.postMessage(
            channelId,
            `⚠️  Added "${fileInfo.name}" to S3, but indexing failed after ${maxRetries} attempts.\n` +
            `Error: ${errorType}\n` +
            `${errorHint}`
          );
        }
      } else {
        await slackService.postMessage(
          channelId,
          `✅ Successfully added "${fileInfo.name}" to knowledge base! (Vector search not available, file stored in S3)`
        );
      }

      console.log(`✅ Successfully processed file: ${fileInfo.name}`);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error processing Slack event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Event deduplication cache - stores processed event IDs with timestamp
const processedEvents = new Map<string, number>();
const EVENT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Cleanup old events every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents.entries()) {
    if (now - timestamp > EVENT_CACHE_TTL) {
      processedEvents.delete(eventId);
    }
  }
}, 10 * 60 * 1000);

// Apply CORS and JSON parsing middleware for all other routes
app.use(cors(corsOptions));
app.use(express.json());

// Initialize Gemini AI
const apiKey = process.env.GOOGLE_AI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey); // Legacy SDK for embeddings
const genAINew = new GoogleGenAI({ apiKey }); // New SDK with web search support

// Initialize Vector Store and Embedding Service
// Dynamic Qdrant URL configuration:
// - Local dev: http://localhost:6333 (default)
// - Docker Compose: http://qdrant:6333 (use service name)
// - Production: https://your-cluster.qdrant.io:6333 (Qdrant Cloud)
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
const useVectorSearch = process.env.USE_VECTOR_SEARCH !== 'false'; // Default to true
let vectorStore: VectorStore | null = null;
let embeddingService: EmbeddingService | null = null;

// Initialize S3 Service
const s3BucketName = process.env.S3_KNOWLEDGE_BASE_BUCKET;
const awsRegion = process.env.AWS_REGION || 'ap-south-1';
let s3Service: S3Service | null = null;

if (s3BucketName) {
  s3Service = new S3Service(s3BucketName, awsRegion);
  console.log(`✅ S3 Service initialized: ${s3BucketName} (${awsRegion})`);
} else {
  console.log('⚠️  S3_KNOWLEDGE_BASE_BUCKET not set, using local filesystem');
}

// Initialize Slack Service
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const slackChannelId = process.env.SLACK_KNOWLEDGE_BASE_CHANNEL;
let slackService: SlackService | null = null;

if (slackBotToken && slackSigningSecret) {
  slackService = new SlackService(slackBotToken, slackSigningSecret);
  console.log(`✅ Slack Service initialized`);
} else {
  console.log('⚠️  Slack credentials not set, Slack integration disabled');
}

// Indexing service will be initialized after vector services
let indexingService: IndexingService | null = null;

// Initialize vector services if enabled
async function initializeVectorServices() {
  if (!useVectorSearch) {
    console.log('⚠️  Vector search disabled');
    return;
  }

  try {
    vectorStore = new VectorStore(qdrantUrl);
    embeddingService = new EmbeddingService(apiKey);

    // Check if collection exists
    const collectionInfo = await vectorStore.getCollectionInfo();
    if (collectionInfo) {
      console.log(`✅ Vector store connected: ${collectionInfo.points_count} vectors`);

      // Initialize indexing service
      indexingService = new IndexingService(vectorStore, embeddingService);
      console.log(`✅ Indexing service ready for auto-indexing`);
    } else {
      console.log('⚠️  Vector store collection not found. Run: npm run populate-vectors');
    }
  } catch (error) {
    console.error('⚠️  Vector store connection failed:', error);
    console.log('   Falling back to full knowledge base mode');
    vectorStore = null;
    embeddingService = null;
    indexingService = null;
  }
}

// Load knowledge base - Supports both S3 and local filesystem
async function loadKnowledgeBase(): Promise<string> {
  try {
    // If S3 is configured, load from S3
    if (s3Service) {
      console.log('📦 Loading knowledge base from S3...');
      const knowledgeBase = await s3Service.loadAllDocuments();
      return knowledgeBase;
    }

    // Fallback to local filesystem
    console.log('📁 Loading knowledge base from local filesystem...');
    const kbPath = path.join(__dirname, '..', 'content', 'knowledge-base');
    if (!fs.existsSync(kbPath)) {
      console.warn('Knowledge base directory not found');
      return 'DPI Knowledge Base: Digital Public Infrastructure (DPI) consists of foundational digital systems.';
    }

    const files = fs.readdirSync(kbPath);
    let knowledgeBase = '';

    // Priority files loaded first
    const priorityFiles = [
      '[DPI GPT assistant] Strategy notes + context compilation.md',
      '[DPI GPT assistant] - Africa Strategy notes + context compilation (1).md',
      'Centre for Digital Public Infrastructure.md',
      'DPI for Healthcare.md',
      'G2P Connect.md'
    ];

    // Load priority files
    for (const priorityFile of priorityFiles) {
      if (files.includes(priorityFile)) {
        const content = fs.readFileSync(path.join(kbPath, priorityFile), 'utf-8');
        knowledgeBase += `\n\n--- PRIORITY: ${priorityFile} ---\n${content}`;
      }
    }

    // Load all other supported files (markdown and PDF)
    for (const file of files) {
      if (isSupportedDocument(file) && !priorityFiles.includes(file)) {
        const filePath = path.join(kbPath, file);
        let content: string;

        if (isPDF(file)) {
          const buffer = fs.readFileSync(filePath);
          content = await extractTextFromPDF(buffer);
        } else {
          content = fs.readFileSync(filePath, 'utf-8');
        }

        knowledgeBase += `\n\n--- ${file} ---\n${content}`;
      }
    }

    console.log(`✅ Knowledge base loaded: ${files.filter(f => isSupportedDocument(f)).length} files, ${knowledgeBase.length} characters`);
    return knowledgeBase;
  } catch (error) {
    console.error('Error loading knowledge base:', error);
    return 'DPI Knowledge Base: Digital Public Infrastructure (DPI) consists of foundational digital systems.';
  }
}

let knowledgeBase: string = '';

// Load prompt templates - LOADS ALL PROMPTS
function loadPromptTemplate(filename: string): string {
  try {
    const promptPath = path.join(__dirname, '..', 'content', 'prompts', filename);
    if (!fs.existsSync(promptPath)) {
      console.warn(`⚠️  Prompt template not found: ${filename}`);
      return '';
    }
    const content = fs.readFileSync(promptPath, 'utf-8');
    console.log(`✅ Loaded prompt template: ${filename} (${content.length} characters)`);
    return content;
  } catch (error) {
    console.error(`❌ Error loading prompt template ${filename}:`, error);
    return '';
  }
}

// Template variable replacement - Supports {{{variable}}} and {{#if}} syntax
function replaceTemplateVariables(template: string, variables: Record<string, string>): string {
  let result = template;

  // Handle {{{variable}}} syntax (triple braces)
  for (const [key, value] of Object.entries(variables)) {
    const tripleRegex = new RegExp(`\\{\\{\\{${key}\\}\\}\\}`, 'g');
    result = result.replace(tripleRegex, value || '');
  }

  // Handle {{#if variable}}...{{/if}} conditional blocks
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
    return variables[varName] ? content : '';
  });

  return result;
}

// Load all prompt templates at startup
const answerPromptTemplate = loadPromptTemplate('answer-dpi-questions-prompt.md');
const suggestDPIsPromptTemplate = loadPromptTemplate('suggest-relevant-dpis-prompt.md');
const summarizeDocumentPromptTemplate = loadPromptTemplate('summarize-documents-prompt.md');

// Create Gemini model with web search and temperature configuration using NEW SDK
function createModelConfig() {
  return {
    model: 'gemini-2.5-flash',
    config: {
      tools: [
        { googleSearch: {} } // Enable web search (Google Search grounding)
      ],
      temperature: 0.7, // Set temperature between 0 and 0.7 for balanced creativity and accuracy
    }
  };
}

// Retry wrapper for Gemini API calls to handle transient 503/429 errors
async function generateContentWithRetry(
  prompt: string,
  maxRetries: number = 3,
  baseDelayMs: number = 2000
): Promise<any> {
  const { model, config } = createModelConfig();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await genAINew.models.generateContent({ model, contents: prompt, config });
    } catch (error: any) {
      const status = error?.status || error?.code;
      const isRetryable = status === 503 || status === 429;
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`⏳ Gemini API returned ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Retrieve relevant context using vector search or fallback to full KB
async function retrieveContext(query: string): Promise<string> {
  // If vector search is available, use it
  if (vectorStore && embeddingService) {
    try {
      const queryEmbedding = await embeddingService.generateEmbedding(query);
      const results = await vectorStore.search(queryEmbedding, 10, 0.65);

      if (results.length > 0) {
        const context = results
          .map(result => `[Source: ${result.metadata.source}]\n${result.text}`)
          .join('\n\n---\n\n');

        console.log(`🔍 Vector search: Found ${results.length} relevant chunks`);
        return context;
      }
    } catch (error) {
      console.error('Vector search error, falling back to full KB:', error);
    }
  }

  // Fallback: Use first 100KB of knowledge base
  console.log('📚 Using full knowledge base (limited to 100KB)');
  return knowledgeBase.substring(0, 100000);
}

// Health check endpoint
app.get('/health', async (req, res) => {
  let vectorStoreStatus = 'disabled';
  let vectorCount = 0;

  if (vectorStore) {
    try {
      const info = await vectorStore.getCollectionInfo();
      vectorStoreStatus = info ? 'connected' : 'not_initialized';
      vectorCount = info?.points_count || 0;
    } catch {
      vectorStoreStatus = 'error';
    }
  }

  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    knowledgeBaseSize: knowledgeBase.length,
    vectorStore: {
      status: vectorStoreStatus,
      vectors: vectorCount
    },
    promptsLoaded: {
      answer: answerPromptTemplate.length > 0,
      suggest: suggestDPIsPromptTemplate.length > 0,
      summarize: summarizeDocumentPromptTemplate.length > 0
    }
  });
});

// Health check with chat functionality test
app.get('/health/full', async (_req, res) => {
  const healthStatus: any = {
    status: 'healthy',
    timestamp: Date.now(),
    checks: {
      api: { status: 'ok', message: 'API is responding' },
      knowledgeBase: { status: 'unknown', size: 0 },
      vectorStore: { status: 'unknown', vectors: 0 },
      prompts: { status: 'unknown', loaded: {} },
      geminiApi: { status: 'unknown', message: '' },
      chat: { status: 'unknown', message: '' }
    }
  };

  // Check knowledge base
  if (knowledgeBase && knowledgeBase.length > 0) {
    healthStatus.checks.knowledgeBase = {
      status: 'ok',
      size: knowledgeBase.length
    };
  } else {
    healthStatus.checks.knowledgeBase = {
      status: 'error',
      size: 0,
      message: 'Knowledge base not loaded'
    };
    healthStatus.status = 'degraded';
  }

  // Check vector store
  if (vectorStore) {
    try {
      const info = await vectorStore.getCollectionInfo();
      healthStatus.checks.vectorStore = {
        status: info ? 'ok' : 'not_initialized',
        vectors: info?.points_count || 0
      };
    } catch (error) {
      healthStatus.checks.vectorStore = {
        status: 'error',
        vectors: 0,
        message: String(error)
      };
    }
  } else {
    healthStatus.checks.vectorStore = {
      status: 'disabled',
      vectors: 0
    };
  }

  // Check prompts
  const promptsOk = answerPromptTemplate.length > 0 &&
                    suggestDPIsPromptTemplate.length > 0 &&
                    summarizeDocumentPromptTemplate.length > 0;
  healthStatus.checks.prompts = {
    status: promptsOk ? 'ok' : 'error',
    loaded: {
      answer: answerPromptTemplate.length > 0,
      suggest: suggestDPIsPromptTemplate.length > 0,
      summarize: summarizeDocumentPromptTemplate.length > 0
    }
  };

  if (!promptsOk) {
    healthStatus.status = 'degraded';
  }

  // Check Gemini API key
  if (apiKey) {
    healthStatus.checks.geminiApi = {
      status: 'ok',
      message: 'API key configured'
    };
  } else {
    healthStatus.checks.geminiApi = {
      status: 'error',
      message: 'API key not configured'
    };
    healthStatus.status = 'unhealthy';
  }

  // Test chat functionality with a simple query
  if (apiKey && answerPromptTemplate.length > 0 && knowledgeBase.length > 0) {
    try {
      const testQuery = 'What is DPI?';
      const relevantContext = await retrieveContext(testQuery);
      const prompt = replaceTemplateVariables(answerPromptTemplate, {
        question: testQuery,
        knowledgeBase: relevantContext,
        chatHistory: '',
        persona: ''
      });

      const result = await generateContentWithRetry(prompt);

      const answer = result.text || '';

      if (answer.length > 0) {
        healthStatus.checks.chat = {
          status: 'ok',
          message: 'Chat functionality working',
          testQuery,
          responseLength: answer.length
        };
      } else {
        healthStatus.checks.chat = {
          status: 'error',
          message: 'Chat returned empty response',
          testQuery
        };
        healthStatus.status = 'degraded';
      }
    } catch (error) {
      healthStatus.checks.chat = {
        status: 'error',
        message: `Chat test failed: ${String(error)}`
      };
      healthStatus.status = 'degraded';
    }
  } else {
    healthStatus.checks.chat = {
      status: 'skipped',
      message: 'Prerequisites not met (API key, prompts, or knowledge base missing)'
    };
    healthStatus.status = 'degraded';
  }

  // Set appropriate HTTP status code
  const httpStatus = healthStatus.status === 'healthy' ? 200 :
                     healthStatus.status === 'degraded' ? 200 : 503;

  res.status(httpStatus).json(healthStatus);
});

// Main chat endpoint - Uses answer-dpi-questions-prompt.md
app.post('/chat', async (req, res) => {
  try {
    const { message, chatHistoryArray, persona } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Use the sophisticated prompt if available, fallback to simple prompt
    if (!answerPromptTemplate) {
      return res.status(500).json({ error: 'Answer prompt template not loaded' });
    }

    // Build chat history
    let chatHistory = '';
    if (chatHistoryArray && Array.isArray(chatHistoryArray)) {
      chatHistory = chatHistoryArray
        .map((m: any) => `${m.sender}: ${m.text || m.answer}`)
        .join('\n');
    }

    // Retrieve relevant context using vector search or fallback
    const relevantContext = await retrieveContext(message);

    // Replace template variables
    const prompt = replaceTemplateVariables(answerPromptTemplate, {
      question: message,
      knowledgeBase: relevantContext,
      chatHistory: chatHistory,
      persona: persona || ''
    });

    // Generate response using new SDK with web search support (with retry for transient errors)
    const result = await generateContentWithRetry(prompt);

    const answer = result.text || '';

    // Log grounding metadata if web search was used
    // Grounding metadata is in candidates[0].groundingMetadata
    const groundingMetadata = (result as any).candidates?.[0]?.groundingMetadata;
    if (groundingMetadata) {
      console.log('🌐 Web search triggered!');
      console.log(`   Search queries: ${groundingMetadata.webSearchQueries?.join(', ') || 'N/A'}`);
      console.log(`   Grounding chunks: ${groundingMetadata.groundingChunks?.length || 0}`);
      if (groundingMetadata.retrievalMetadata?.googleSearchDynamicRetrievalScore) {
        console.log(`   Retrieval score: ${groundingMetadata.retrievalMetadata.googleSearchDynamicRetrievalScore}`);
      }
    } else {
      console.log('📚 Response generated from knowledge base only (no web search)');
    }

    res.json({
      id: randomUUID(),
      sender: 'assistant',
      answer,
      sources: [], // Sources hidden as requested
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
});

// DPI Suggestions endpoint - Uses suggest-relevant-dpis-prompt.md
app.post('/suggest-dpis', async (req, res) => {
  try {
    const { useCase, context, country } = req.body;

    if (!useCase || typeof useCase !== 'string') {
      return res.status(400).json({ error: 'Use case is required' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    if (!suggestDPIsPromptTemplate) {
      return res.status(500).json({ error: 'DPI suggestions prompt template not loaded' });
    }

    // Replace template variables
    const prompt = replaceTemplateVariables(suggestDPIsPromptTemplate, {
      useCase: useCase,
      additionalContext: context || '',
      countryContext: country || '',
      knowledgeBase: knowledgeBase
    });

    const result = await generateContentWithRetry(prompt);

    const rawAnswer = result.text || '';

    // Log grounding metadata if web search was used
    const groundingMetadata = (result as any).candidates?.[0]?.groundingMetadata;
    if (groundingMetadata) {
      console.log('🌐 [suggest-dpis] Web search triggered!');
      console.log(`   Search queries: ${groundingMetadata.webSearchQueries?.join(', ') || 'N/A'}`);
      console.log(`   Grounding chunks: ${groundingMetadata.groundingChunks?.length || 0}`);
    } else {
      console.log('📚 [suggest-dpis] Response from knowledge base only (no web search)');
    }

    res.json({
      id: randomUUID(),
      suggestions: rawAnswer,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error in suggest-dpis endpoint:', error);
    res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
});

// Document Summarization endpoint - Uses summarize-documents-prompt.md
app.post('/summarize', async (req, res) => {
  try {
    const { documentContent, documentTitle } = req.body;

    if (!documentContent || typeof documentContent !== 'string') {
      return res.status(400).json({ error: 'Document content is required' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    if (!summarizeDocumentPromptTemplate) {
      return res.status(500).json({ error: 'Summarize prompt template not loaded' });
    }

    // Replace template variables
    const prompt = replaceTemplateVariables(summarizeDocumentPromptTemplate, {
      documentContent: documentContent,
      documentTitle: documentTitle || 'Untitled Document'
    });

    const result = await generateContentWithRetry(prompt);

    const summary = result.text || '';

    res.json({
      id: randomUUID(),
      summary,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error in summarize endpoint:', error);
    res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
});

// Manual re-index endpoint - Re-index a specific document from S3
app.post('/reindex', async (req, res) => {
  try {
    const { fileName } = req.body;

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (!s3Service) {
      return res.status(503).json({ error: 'S3 service not configured' });
    }

    if (!indexingService) {
      return res.status(503).json({ error: 'Indexing service not available. Check if Qdrant is running.' });
    }

    console.log(`🔄 Manual re-index requested for: ${fileName}`);

    // Download file from S3
    const fileBuffer = await s3Service.downloadFile(fileName);

    // Extract text content based on file type
    let content: string;
    if (isPDF(fileName)) {
      content = await extractTextFromPDF(fileBuffer);
    } else {
      content = fileBuffer.toString('utf-8');
    }

    // Index the document
    await indexingService.indexDocument(fileName, content);

    console.log(`✅ Successfully re-indexed: ${fileName}`);
    res.json({
      success: true,
      message: `Successfully indexed "${fileName}"`,
      fileName
    });
  } catch (error) {
    console.error('Error re-indexing document:', error);
    res.status(500).json({
      error: 'Failed to re-index document',
      details: String(error)
    });
  }
});

// Re-index all documents from S3
app.post('/reindex-all', async (req, res) => {
  try {
    if (!s3Service) {
      return res.status(503).json({ error: 'S3 service not configured' });
    }

    if (!indexingService) {
      return res.status(503).json({ error: 'Indexing service not available. Check if Qdrant is running.' });
    }

    console.log(`🔄 Re-indexing all documents from S3...`);

    // Get all files from S3
    const files = await s3Service.listFiles();
    console.log(`📋 Found ${files.length} files in S3`);

    const results = {
      total: files.length,
      success: 0,
      failed: 0,
      errors: [] as Array<{ fileName: string; error: string }>
    };

    // Index each file
    for (const fileName of files) {
      try {
        console.log(`📝 Processing: ${fileName}`);
        const fileBuffer = await s3Service.downloadFile(fileName);

        // Extract text content based on file type
        let content: string;
        if (isPDF(fileName)) {
          content = await extractTextFromPDF(fileBuffer);
        } else {
          content = fileBuffer.toString('utf-8');
        }

        await indexingService.indexDocument(fileName, content);
        results.success++;
        console.log(`  ✅ Indexed: ${fileName}`);
      } catch (error) {
        results.failed++;
        const errorMsg = String(error);
        results.errors.push({ fileName, error: errorMsg });
        console.error(`  ❌ Failed to index ${fileName}:`, error);
      }
    }

    console.log(`\n✅ Re-indexing complete: ${results.success} success, ${results.failed} failed`);

    res.json({
      success: true,
      message: 'Re-indexing complete',
      results
    });
  } catch (error) {
    console.error('Error in re-index-all:', error);
    res.status(500).json({
      error: 'Failed to re-index documents',
      details: String(error)
    });
  }
});

// Feedback endpoint (NO AUTHENTICATION REQUIRED)
app.post('/feedback', (req, res) => {
  const { messageId, feedback } = req.body;
  console.log(`Feedback received for message ${messageId}: ${feedback}`);
  res.json({ success: true, message: 'Feedback received' });
});

// Start server
async function startServer() {
  // Load knowledge base
  knowledgeBase = await loadKnowledgeBase();

  // Initialize vector services
  await initializeVectorServices();

  app.listen(port, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 DPI Sage backend running on port ${port}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📚 Knowledge Base: ${knowledgeBase.length.toLocaleString()} characters`);
    console.log(`📦 Storage: ${s3Service ? `S3 (${s3BucketName})` : 'Local Filesystem'}`);
    console.log(`📝 Prompts Loaded:`);
    console.log(`   - answer-dpi-questions: ${answerPromptTemplate ? '✅' : '❌'} (${answerPromptTemplate.length} chars)`);
    console.log(`   - suggest-relevant-dpis: ${suggestDPIsPromptTemplate ? '✅' : '❌'} (${suggestDPIsPromptTemplate.length} chars)`);
    console.log(`   - summarize-documents: ${summarizeDocumentPromptTemplate ? '✅' : '❌'} (${summarizeDocumentPromptTemplate.length} chars)`);
    console.log(`🔍 Retrieval: ${vectorStore ? 'Vector Search (Semantic)' : 'Full KB (Limited to 100KB)'}`);
    console.log(`⚠️  WARNING: Running without authentication`);
    console.log(`${'='.repeat(60)}\n`);
  });
}

startServer();
