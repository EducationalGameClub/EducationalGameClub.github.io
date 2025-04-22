import * as marked from 'marked';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import * as ics from 'ics';

const ANSI = {
  reset: '\x1b[0m',

  bright: '\x1b[1m',

  fgRed: '\x1b[31m',
};

function style(styles, text) {
  return styles.join('') + text + ANSI.reset;
}

function pp(x) {
  return JSON.stringify(x, undefined, 2);
}

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
  // Require `uid` so calendar events in ICS files maintain their UIDs across
  // builds of the web site.
  assert('uid' in evt, `eventIcs: 'uid' is a required field of 'evt'. evt: ${pp(evt)}`);

  const icsData = ics.createEvent({
    uid: evt.uid,
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

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, { encoding: 'utf8' });
  } catch (ex) {
    if (ex.code === 'ENOENT') {
      return undefined;
    } else {
      throw ex;
    }
  }
}

async function writeIcsFileIfChanged(filePath, ics) {
  let didChange = false;

  const prevIcs = await readFileIfExists(filePath);
  if (prevIcs === undefined) {
    // File doesn't exist.
    didChange = true;
  } else {
    const prevLines = prevIcs.split('\n');
    const nextLines = ics.split('\n');

    if (prevLines.length === nextLines.length) {
      for (let i = 0; i < prevLines.length; ++i) {
        const prevLine = prevLines[i];
        const nextLine = nextLines[i];

        // This changes every time the file is written so it's not representative
        // of the file's content changing.
        if (prevLine.startsWith('DTSTAMP:') && nextLine.startsWith('DTSTAMP:')) continue;

        if (prevLine !== nextLine) {
          didChange = true;
          break;
        }
      }
    }
  }

  if (didChange) {
    await fs.writeFile(filePath, ics, { encoding: 'utf8' });
  }
}

async function renderEventPage(evt) {
  function replaceVariables(s, evt) {
    return (
      s
        .replaceAll('$$EventUrl$$', evt.eventUrl)
        .replaceAll('$$EventTitle$$', evt.title)
        .replaceAll('$$EventBrief$$', evt.brief ?? '')
        .replaceAll('$$PageTitle$$', pageTitle(evt))
        .replaceAll('$$CallUrl$$', evt.callUrl)
        .replaceAll('$$GoogleCalendarUrl$$', eventAddToGoogleCalendarUrl(evt))
        .replaceAll('$$PastEventDisplay$$', evt.isPastEvent ? 'block' : 'none')
        .replaceAll('$$ImageUrl$$', evt.image ? evt.eventUrl + evt.image.name : '')
        .replaceAll('$$ImageWidth$$', evt.image ? evt.image.width : '')
        .replaceAll('$$ImageHeight$$', evt.image ? evt.image.height : '')
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
  await writeIcsFileIfChanged(path.join(evt.outDirPath, 'event.ics'), eventIcs(evt));
  if (evt.image) {
    await fs.copyFile(path.join(evt.inDirPath, evt.image.name), path.join(evt.outDirPath, evt.image.name));
  }
}


async function renderPage(page) {
  function replaceVariables(s, page) {
    return (
      s
        .replaceAll('$$PageUrl$$', page.url)
        .replaceAll('$$PageTitle$$', page.title)
        .replaceAll('$$PageBrief$$', page.brief)
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

async function renderNextEventPage(config) {
  function replaceVariables(s, config) {
    return (
      s
        .replaceAll('$$EventUrl$$', config.nextEvent.eventUrl)
    );
  }

  const template = await fs.readFile('./next-event-template.html', { encoding: 'utf8' });
  const pageHtml = replaceVariables(template, config);
  return pageHtml;
}

async function handleNextEventPage(config) {
  const pageHtml = await renderNextEventPage(config);

  spawn('mkdir', '-p', path.dirname(config.outPath));
  await fs.writeFile(config.outPath, pageHtml, { encoding: 'utf8' });
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

function makeUtcDate(year, month = 1, day = 1, hour = 0, minute = 0) {
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
  const events = [
    {
      title: 'Discussion of Portal',
      uid: 'cb544ca5-52d5-47b0-abfb-30623a007f4b',
      start: makeUtcDate(2024, 12, 20, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/nyk-twnw-anu',
      eventUrl: 'https://EducationalGameClub.github.io/events/2024-12/',
      isPastEvent: true,
    
      inDirPath: './content/events/2024-12/',
      outDirPath: './_gh-pages/events/2024-12/',
    },
    
    {
      title: 'Discussion of Headlines and High Water',
      uid: 'a5K-9JBCcND-1KgQpiX6l',
      start: makeUtcDate(2025, 1, 17, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/izp-ezjm-cyj',
      eventUrl: 'https://EducationalGameClub.github.io/events/2025-01/',
      isPastEvent: true,
    
      inDirPath: './content/events/2025-01/',
      outDirPath: './_gh-pages/events/2025-01/',
    },

    {
      uid: '38d36e04-6b73-4870-8348-dae1421b5968',
      title: 'Discussion of DragonBox Algebra',
      brief: `We'll be discussing DragonBox Algebra, a game where players learn concepts from algebra experientially through puzzles of gradually increasing difficulty.`,
      start: makeUtcDate(2025, 2, 20, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/amb-hvoh-moy',
      eventUrl: 'https://EducationalGameClub.github.io/events/2025-02/',
      image: { name: 'image.png', width: 600, height: 337 },
      isPastEvent: true,
    
      inDirPath: './content/events/2025-02/',
      outDirPath: './_gh-pages/events/2025-02/',
    },
    {
      uid: 'ea382f95-9971-436b-924d-e485ee9db2c6',
      title: 'Discussion of Night of the Living Debt',
      brief: `We'll be discussing the game Night of the Living Debt which is designed to promote financial literacy among young adults, especially around credit score.`,
      start: makeUtcDate(2025, 3, 28, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/oyh-odwe-qzx',
      eventUrl: 'https://EducationalGameClub.com/events/2025-03/',
      image: { name: 'image.jpg', width: 800, height: 450 },
      isPastEvent: true,
    
      inDirPath: './content/events/2025-03/',
      outDirPath: './_gh-pages/events/2025-03/',
    },
    {
      uid: '83ee434a-2f97-447b-91b6-de8d35a7ca2c',
      title: 'Discussion of Executive Command',
      brief: `We'll be discussing Executive Command by iCivics, a game where you play as President of the United States. Learn what the president does and how they work with the rest of the government.`,
      start: makeUtcDate(2025, 5, 1, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/xpf-nxsi-ehp',
      eventUrl: 'https://EducationalGameClub.com/events/2025-04/',
      image: { name: 'image.jpg', width: 1920, height: 1008 },
      // isPastEvent: true,
    
      inDirPath: './content/events/2025-04/',
      outDirPath: './_gh-pages/events/2025-04/',
    }
  ];
  const nextEvent = events[events.length - 1]; // Assumes they're sorted by ascending date

  await handleVersionTxt({ outDirPath: './_gh-pages/' });

  await handlePage({
    title: 'Educational Game Club',
    brief: `It's like a book club but for educational games. Each month we pick one, play it, and then meet to discuss it.`,
    url: 'https://EducationalGameClub.com/',
  
    inDirPath: './content/',
    outDirPath: './_gh-pages/',
  });

  for (const evt of events)  {
    await handleEventPage(evt);
  }

  await handleNextEventPage({
    nextEvent: nextEvent,

    outPath: './_gh-pages/events/next.html',
  });

  const messages = [
    `${style([ANSI.bright], nextEvent.title)} (next event)`,
  ];

  if (gitHasLocalChanges()) {
    messages.push(`${style([ANSI.fgRed, ANSI.bright], 'WARNING:')} git has local changes`);
  }

  console.log(`\n${messages.join('\n')}\n`);
}

main();
