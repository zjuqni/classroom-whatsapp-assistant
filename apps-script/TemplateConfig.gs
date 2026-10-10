/** Load deployment settings from Apps Script's private Script Properties. */
function getTemplateSettings_() {
  const props = PropertiesService.getScriptProperties();
  const readJson = (key, fallback) => {
    const raw = props.getProperty(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); }
    catch (_) { throw new Error(key + " must contain valid JSON."); }
  };
  return {
    timeZone: props.getProperty("APP_TIMEZONE") || "Etc/UTC",
    responseLanguage: props.getProperty("RESPONSE_LANGUAGE") || "English",
    pollingIntervalMinutes: Number(props.getProperty("POLL_INTERVAL_MINUTES") || 15),
    dateOnlyDueTime: props.getProperty("DATE_ONLY_DUE_TIME") || "23:59",
    vertexLocation: props.getProperty("VERTEX_LOCATION") || "global",
    courseIds: readJson("CLASSROOM_COURSE_IDS_JSON", []),
    subjectAliases: readJson("SUBJECT_ALIASES_JSON", {}),
    weeklySchedule: readJson("WEEKLY_SCHEDULE_JSON", {}),
    periodStartTimes: readJson("CLASS_PERIOD_TIMES_JSON", {})
  };
}

/** Validate settings without consulting Classroom, calling Vertex, or sending messages. */
function validateTemplateConfiguration() {
  const settings = getTemplateSettings_();
  const props = PropertiesService.getScriptProperties();
  const required = ["VERTEX_PROJECT_ID", "VERTEX_MODEL", "WA_BRIDGE_URL", "WA_BRIDGE_TOKEN", "WA_BOT_GROUP_ID"];
  required.forEach(key => {
    const value = props.getProperty(key) || "";
    if (!value || /YOUR_|REPLACE_WITH/i.test(value)) throw new Error("Set " + key + " in Script Properties.");
  });
  if ((props.getProperty("WA_BRIDGE_TOKEN") || "").length < 32) throw new Error("WA_BRIDGE_TOKEN must contain at least 32 characters.");
  if (!/^https:\/\//i.test(props.getProperty("WA_BRIDGE_URL"))) throw new Error("WA_BRIDGE_URL must use HTTPS.");
  if (![1, 5, 10, 15, 30].includes(settings.pollingIntervalMinutes)) throw new Error("POLL_INTERVAL_MINUTES must be 1, 5, 10, 15, or 30.");
  if (!Array.isArray(settings.courseIds) || settings.courseIds.some(id => typeof id !== "string")) throw new Error("CLASSROOM_COURSE_IDS_JSON must be an array of string IDs.");
  const objectSettings = ["subjectAliases", "weeklySchedule", "periodStartTimes"];
  objectSettings.forEach(key => {
    if (!settings[key] || Array.isArray(settings[key]) || typeof settings[key] !== "object") throw new Error(key + " must be an object.");
  });
  const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(settings.dateOnlyDueTime)) throw new Error("DATE_ONLY_DUE_TIME must use HH:mm (24-hour time).");
  Object.values(settings.subjectAliases).forEach(aliases => {
    if (!Array.isArray(aliases) || !aliases.length || aliases.some(alias => typeof alias !== "string" || !alias.trim())) throw new Error("Each subject must have a nonempty array of course-name aliases.");
  });
  Object.entries(settings.periodStartTimes).forEach(([period, time]) => {
    if (!period || !validTime(time)) throw new Error("Class period start times must use HH:mm.");
  });
  Object.entries(settings.weeklySchedule).forEach(([subject, days]) => {
    if (!Object.prototype.hasOwnProperty.call(settings.subjectAliases, subject)) throw new Error("Add course-name aliases for the scheduled subject: " + subject);
    if (!days || Array.isArray(days) || typeof days !== "object") throw new Error("A subject's schedule must be an object keyed by weekday number.");
    Object.entries(days).forEach(([day, periods]) => {
      if (!/^[1-7]$/.test(day) || !Array.isArray(periods)) throw new Error("Weekdays must be 1 (Monday) through 7 (Sunday), with arrays of period IDs.");
      periods.forEach(period => {
        if (!Object.prototype.hasOwnProperty.call(settings.periodStartTimes, period)) throw new Error("Missing start time for period: " + period);
      });
    });
  });
  Utilities.formatDate(new Date(), settings.timeZone, "yyyy-MM-dd HH:mm");
  console.log("Template configuration is valid. No messages were sent.");
  return settings;
}
