const express = require('express');
const { handleOnlyofficeDownload, handleOnlyofficeCallback } = require('../services/kbOnlyofficeService');

const router = express.Router();

router.get('/download', async (req, res, next) => {
  try {
    await handleOnlyofficeDownload(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post('/callback', express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    await handleOnlyofficeCallback(req, res);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
