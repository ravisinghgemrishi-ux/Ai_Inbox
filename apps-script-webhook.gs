function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = JSON.parse(e.postData.contents);

  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    data.platform || '',
    data.contact || '',
    data.type || '',
    data.message || '',
    data.reply || '',
    data.leadStatus || '',
    data.productInterest || '',
    data.escalated || '',
    data.notes || '',
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
