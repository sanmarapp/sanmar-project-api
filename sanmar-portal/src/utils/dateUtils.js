'use strict';

// Bangladesh public holidays 2026
const HOLIDAYS_2026 = new Set([
  '2026-02-21','2026-03-17','2026-03-26','2026-04-14',
  '2026-05-01','2026-06-06','2026-06-07','2026-08-15',
  '2026-10-13','2026-12-16','2026-12-25',
]);

// BD weekend: Friday=5, Saturday=6
function isWorkingDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDay();
  if (day === 5 || day === 6) return false;
  const iso = d.toISOString().split('T')[0];
  return !HOLIDAYS_2026.has(iso);
}

function nextWorkingDay(date) {
  const d = new Date(date);
  while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
  return d;
}

function addWorkingDays(startStr, leadDays) {
  const total = parseInt(leadDays, 10);
  if (!startStr || isNaN(total) || total <= 0) return startStr;
  let d = nextWorkingDay(new Date(startStr + 'T00:00:00'));
  let counted = 1;
  while (counted < total) {
    d.setDate(d.getDate() + 1);
    d = nextWorkingDay(d);
    counted++;
  }
  return d.toISOString().split('T')[0];
}

function workingDaysDelayed(plannedEndStr, todayStr) {
  if (!plannedEndStr) return 0;
  const planned = new Date(plannedEndStr + 'T00:00:00');
  const today   = new Date(todayStr   + 'T00:00:00');
  if (planned >= today) return 0;
  let count = 0;
  const cursor = new Date(planned);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= today) {
    if (isWorkingDay(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function todayBD() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

module.exports = { isWorkingDay, addWorkingDays, workingDaysDelayed, todayBD, nextWorkingDay };
