import * as marked from 'marked';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import * as ics from 'ics';
import { error } from 'console';

function assert(pred, msg) {
  if (!pred) {
    throw new Error(msg);
  }
}

function spawn2(command, args, options) {
  const result = child_process.spawnSync(command, args, options);
  if (result.status !== 0) {
    throw new Error('command (' + command + ') failed: ' + result.status + '. ' + result.stderr);
  }
  return result.stdout.toString('utf8');
}

function spawn(command, ...args) {
  return spawn2(command, args, undefined);
}

function gitHasLocalChanges() {
  return spawn('git', 'status', '--porcelain').trim().length > 0;
}

function gitHeadSha() {
  return spawn('git', 'rev-parse', 'HEAD').toString('utf8').trim();
}

function calendarEventTitle(evt) {
  return 'Educational Game Club ' + evt.title;
}

function pageTitle(evt) {
  return 'Educational Game Club Event: ' + evt.title;
}

function eventCalendarDescription(evt) {
  return (
    `Join video call: ${evt.callUrl}\n\n` +
    `Event details: ${evt.eventUrl}`
  );
}

function eventAddToGoogleCalendarUrl(evt) {
  return renderAddToGoogleCalendarUrl({
    title: calendarEventTitle(evt),
    location: 'Online event',
    startDate: evt.start,
    endDate: addDuration(evt.start, evt.duration),
    description: eventCalendarDescription(evt),
  });
}

function eventIcs(evt) {
  const icsData = ics.createEvent({
    title: calendarEventTitle(evt),
    startInputType: 'utc',
    start: toUtcDateArray(evt.start),
    duration: evt.duration,
    location: evt.callUrl,
    description: eventCalendarDescription(evt),
    url: evt.eventUrl.toLowerCase(),
  });

  assert(!icsData.error, JSON.stringify(icsData.error, undefined, 2));
  return icsData.value;
}

async function renderEventPage(evt) {
  function replaceVariables(s, evt) {
    return (
      s
        .replaceAll('$$EventTitle$$', evt.title)
        .replaceAll('$$PageTitle$$', pageTitle(evt))
        .replaceAll('$$CallUrl$$', evt.callUrl)
        .replaceAll('$$GoogleCalendarUrl$$', eventAddToGoogleCalendarUrl(evt))
    );
  }

  const template = await fs.readFile('./event-template.html', { encoding: 'utf8' });
  const eventBodyMarkdown = await fs.readFile(path.join(evt.inDirPath, 'index.md'), { encoding: 'utf8' });
  const eventBodyHtml = marked.parse(replaceVariables(eventBodyMarkdown, evt));

  return (
    replaceVariables(template, evt).replaceAll('$$EventBody$$', eventBodyHtml)
  );
}

async function handleEventPage(evt) {
  const eventHtml = await renderEventPage(evt);

  spawn('mkdir', '-p', evt.outDirPath);
  await fs.writeFile(path.join(evt.outDirPath, 'index.html'), eventHtml, { encoding: 'utf8' });
  await fs.writeFile(path.join(evt.outDirPath, 'event.ics'), eventIcs(evt), { encoding: 'utf8' });
}


async function renderPage(page) {
  function replaceVariables(s, page) {
    return (
      s
        .replaceAll('$$PageTitle$$', page.title)
    );
  }

  const template = await fs.readFile('./page-template.html', { encoding: 'utf8' });
  const pageBodyMarkdown = await fs.readFile(path.join(page.inDirPath, 'index.md'), { encoding: 'utf8' });
  const pageBodyHtml = marked.parse(replaceVariables(pageBodyMarkdown, page));

  return (
    replaceVariables(template, page).replaceAll('$$PageBody$$', pageBodyHtml)
  );
}

async function handlePage(page) {
  const pageHtml = await renderPage(page);

  spawn('mkdir', '-p', page.outDirPath);
  await fs.writeFile(path.join(page.outDirPath, 'index.html'), pageHtml, { encoding: 'utf8' });
}

async function handleVersionTxt(config) {
  await fs.writeFile(
    path.join(config.outDirPath, 'version.txt'),
    gitHeadSha() + (gitHasLocalChanges() ? ' with local changes' : ''),
    { encoding: 'utf8' },
  );
}

function renderAddToGoogleCalendarUrl(evt) {
  function pad2Digits(n) {
    return ('' + n).padStart(2, 0);
  }

  function fmtDate(date) {
    return (
      date.getUTCFullYear() +
      pad2Digits(date.getUTCMonth() + 1) +
      pad2Digits(date.getUTCDate()) +
      'T' +
      pad2Digits(date.getUTCHours()) +
      pad2Digits(date.getUTCMinutes()) +
      pad2Digits(date.getUTCSeconds()) +
      'Z'
    );
  }

  return (
    'https://www.google.com/calendar/event' +
    '?action=TEMPLATE' +
    '&location=' + encodeURIComponent(evt.location) +
    '&text=' + encodeURIComponent(evt.title) +
    '&details=' + encodeURIComponent(evt.description) +
    '&dates=' + encodeURIComponent(fmtDate(evt.startDate) + '/' + fmtDate(evt.endDate))
  );
}

function makeUtcDate(year, month = 1, day = 0, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

function toUtcDateArray(date) {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
}

function addDuration(date, duration) {
  const outDate = new Date(date);
  if (duration.hours) outDate.setHours(outDate.getHours() + duration.hours);
  if (duration.minutes) outDate.setMinutes(outDate.getMinutes() + duration.minutes);
  if (duration.seconds) outDate.setSeconds(outDate.getSeconds() + duration.seconds);
  return outDate;
}

const daysOfWeek = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function renderDate(date) {
  return (
    daysOfWeek[date.getDay()] + ' ' +
    months[date.getMonth()] + ' ' +
    date.getDate() + ', ' +
    date.getFullYear()
  );
}

function getHours12(date) {
  const hours = date.getHours();
  return (
    hours === 0 ? ['12', 'AM'] :
    hours < 12 ? [hours, 'AM'] :
    hours === 12 ? [hours, 'PM'] :
    [hours - 12, 'PM']
  );
}

function renderTime(date) {
  const [hours, amPm] = getHours12(date);

  return (
    hours + ':' +
    ('' + date.getMinutes()).padStart(2, '0') + ' ' +
    amPm
  );
}

function renderDateTime(date) {
  return renderDate(date) + ' ' + renderTime(date);
}

async function main() {
  await handleVersionTxt({ outDirPath: './_gh-pages/' });

  await handlePage({
    title: 'Educational Game Club',
  
    inDirPath: './content/',
    outDirPath: './_gh-pages/',
  });
  
  await handleEventPage({
    title: 'Discussion of Headlines and High Water',
    start: makeUtcDate(2025, 1, 17, 2),
    duration: { hours: 1, minutes: 30 },
    callUrl: 'https://meet.google.com/izp-ezjm-cyj',
    eventUrl: 'https://EducationalGameClub.github.io/events/2025-01/',
  
    inDirPath: './content/events/2025-01/',
    outDirPath: './_gh-pages/events/2025-01/',
  });
  
  if (gitHasLocalChanges()) {
    console.log('\nWarning: git has local changes\n');
  }
}

main();
