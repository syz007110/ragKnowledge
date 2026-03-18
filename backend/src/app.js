const express = require('express');
const cors = require('cors');

const healthRouter = require('./routes/health');
const kbRouter = require('./routes/kb');
const authRouter = require('./routes/auth');
const { localeMiddleware } = require('./middlewares/locale');

const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(localeMiddleware);

app.get('/', (req, res) => {
  res.send('MKnowledge backend is running.');
});

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/kb', kbRouter);

app.use((error, req, res, next) => {
  console.error('[api] unhandled error:', error);
  const errorMessage = String(error?.message || '');
  if (error?.message === 'kb.fileExtUnsupported') {
    return res.status(400).json({
      messageKey: 'kb.fileExtUnsupported',
      message: req.t ? req.t('kb.fileExtUnsupported') : 'Unsupported file extension'
    });
  }
  if (errorMessage.startsWith('kb.ragflow.datasetSyncFailed')) {
    return res.status(502).json({
      messageKey: 'kb.ragflow.datasetSyncFailed',
      message: req.t ? req.t('kb.ragflow.datasetSyncFailed') : 'RagFlow dataset synchronization failed',
      detail: process.env.NODE_ENV === 'production' ? undefined : errorMessage
    });
  }
  if (errorMessage.startsWith('kb.ragflow.documentSyncFailed')) {
    return res.status(502).json({
      messageKey: 'kb.ragflow.documentSyncFailed',
      message: req.t ? req.t('kb.ragflow.documentSyncFailed') : 'RagFlow document synchronization failed',
      detail: process.env.NODE_ENV === 'production' ? undefined : errorMessage
    });
  }
  if (error?.code === 'LIMIT_FILE_SIZE' || error?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      messageKey: 'kb.uploadLimitExceeded',
      message: req.t ? req.t('kb.uploadLimitExceeded') : 'Upload limit exceeded'
    });
  }
  res.status(500).json({
    messageKey: 'common.internalError',
    message: req.t ? req.t('common.internalError') : 'Internal server error',
    detail: process.env.NODE_ENV === 'production' ? undefined : errorMessage
  });
});

module.exports = app;
