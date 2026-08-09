// ============================================================
// utils/response.utils.js — Standardised API Responses
// ============================================================
// Every single API endpoint in this project uses these two
// functions to send responses. This guarantees the frontend
// always gets the same JSON shape regardless of which route
// it called.
//
// Success shape:
//   { success: true, message: "...", data: {...}, timestamp }
//
// Error shape:
//   { success: false, error: "...", code: 400, errors: [] }
// ============================================================

const ok = (res, data = null, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success:   true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
};

const err = (res, message = 'Something went wrong', statusCode = 400, errors = []) => {
  const body = {
    success:   false,
    error:     message,
    code:      statusCode,
    timestamp: new Date().toISOString(),
  };
  if (errors.length > 0) body.errors = errors;
  return res.status(statusCode).json(body);
};

module.exports = { ok, err };