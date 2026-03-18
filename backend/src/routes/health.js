const express = require('express');
const { testMySQLConnection } = require('../config/mysql');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    await testMySQLConnection();
    res.json({
      status: 'ok',
      service: 'mknowledge-backend',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
