'use strict';

const ok  = (res, data = {}, status = 200) => res.status(status).json({ success: true,  ...data });
const err = (res, message, status = 400)   => res.status(status).json({ success: false, message });
const notFound  = (res, msg = 'Not found')      => err(res, msg, 404);
const forbidden = (res, msg = 'Access denied')  => err(res, msg, 403);
const serverErr = (res, msg = 'Server error')   => err(res, msg, 500);

module.exports = { ok, err, notFound, forbidden, serverErr };
