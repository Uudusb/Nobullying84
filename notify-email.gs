/**
 * Google Apps Script — гомдлын и-мэйл мэдэгдэл
 *
 * Энэ файлыг script.google.com дээрх төсөлдөө хуулж,
 * Deploy → Manage deployments → Edit → New version → Deploy хийнэ.
 * Web app: Execute as "Me", Who has access: "Anyone".
 *
 * Сайтын NOTIFY_URL-ийг шинэ deployment URL-тай тааруулна (шаардлагатай бол).
 */

var EMAIL_AKHLAKH = "azaa.m0623@gmail.com";
var EMAIL_DUND = "damchiibadgarsaranbileg@gmail.com";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var level = data.level || "";
    var to =
      data.to ||
      data.email ||
      (level === "Ахлах анги" ? EMAIL_AKHLAKH : EMAIL_DUND);

    MailApp.sendEmail({
      to: to,
      subject: data.subject || ("[Дээрэлхэлт] Шинэ мэдэгдэл #" + (data.code || "")),
      body: data.message || ""
    });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, to: to }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
