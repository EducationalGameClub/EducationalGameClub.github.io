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

// Escapes text so it's safe to use in:
//   - HTML contexts (e.g. <div>TEXT</div>)
//   - HTML attribute value contexts (e.g. <div class="TEXT"></div>)
//
// The list is from:
//   https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html#output-encoding-for-html-contexts
function escapeHtml(text) {
  return (
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll('\'', '&#x27;')
  );
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

function replaceVariables(s, variables) {
  return Object.entries(variables).reduce(
    (acc, [varName, varValue]) => acc.replaceAll(`$$${varName}$$`, varValue),
    s
  );
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
  const variables = {
    TopMenu: evt.topMenu ?? '',
    EventUrl: evt.eventUrl,
    EventTitle: escapeHtml(evt.title),
    EventBrief: evt.brief ?? '',
    PageTitle: escapeHtml(pageTitle(evt)),
    CallUrl: evt.callUrl,
    GoogleCalendarUrl: eventAddToGoogleCalendarUrl(evt),
    PastEventDisplay: evt.isPastEvent ? 'block' : 'none',
    ImageUrl: evt.image ? evt.eventUrl + evt.image.name : '',
    ImageWidth: evt.image ? evt.image.width : '',
    ImageHeight: evt.image ? evt.image.height : '',
  };

  const template = await fs.readFile('./event-template.html', { encoding: 'utf8' });
  const eventBodyMarkdown = await fs.readFile(path.join(evt.inDirPath, 'index.md'), { encoding: 'utf8' });
  const eventBodyHtml = marked.parse(replaceVariables(eventBodyMarkdown, variables));

  return replaceVariables(template, { ...variables, EventBody: eventBodyHtml });
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
  const variables = {
    ...page.variables,

    PageUrl: page.url,
    PageTitle: page.title,
    PageBrief: page.brief,
  };

  const template = await fs.readFile('./page-template.html', { encoding: 'utf8' });
  const pageBodyMarkdown = await fs.readFile(path.join(page.inDirPath, `${page.fileBase}.md`), { encoding: 'utf8' });
  const pageBodyHtml = marked.parse(replaceVariables(pageBodyMarkdown, variables));

  return replaceVariables(template, { ...variables, PageBody: pageBodyHtml });
}

async function handlePage(page) {
  const pageHtml = await renderPage(page);

  spawn('mkdir', '-p', page.outDirPath);
  await fs.writeFile(path.join(page.outDirPath, `${page.fileBase}.html`), pageHtml, { encoding: 'utf8' });
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

function renderTopMenu(items, selectedItemId=undefined) {
  function renderMenuItem({id, label, url}) {
    return (
      id === selectedItemId ? `<li class="menu-selected">${label}</li>` :
      `<li><a href="${url}">${label}</a></li>`
    );
  }

  return `
<style>
  .top-menu {
    font-size: 0.875rem;
  }
  .top-menu ul {
    list-style: none;
    padding: 0;
    border: 0;
    margin-left: 0; margin-right: 0; margin-top: 0;
    margin-bottom: 16px;
    display: flex;
    align-items: baseline;
    column-gap: 1rem;
  }
  .top-menu .menu-selected {
    font-weight: bold;
    border-bottom: solid black 2px;
  }
</style>
<nav class="top-menu">
  <ul>
  ${items.map(item => renderMenuItem(item)).join('\n')}
  </ul>
</nav>
`;
}

async function main() {
  const geniventureMenuItems = [
    { id: 'event', label: 'Event', url: './index.html' },
    { id: 'play', label: 'Play', url: './play.html' },
    { id: 'hints', label: 'Hints', url: './hints.html' },
  ];
  const rogueStoryMenuItems = [
    { id: 'event', label: 'Event', url: './index.html' },
    { id: 'trailer', label: 'Trailer', url: './trailer.html' },
    { id: 'play', label: 'Play', url: './play.html' },
    { id: 'feedback', label: 'Feedback', url: './feedback.html' },
  ];

  const pages = [
    {
      title: 'Educational Game Club',
      brief: `It's like a book club but for educational games. Each month we pick one, play it, and then meet to discuss it.`,
      url: 'https://EducationalGameClub.com/',

      fileBase: 'index',
      inDirPath: './content/',
      outDirPath: './_gh-pages/',
    },
    {
      title: 'Playing Geniventure',
      brief: `Geniventure is designed to be played in a classroom with an instructor so playing it on your own involves a few extra steps. This short guide explains how to get started.`,
      url: 'https://EducationalGameClub.com/events/2025-06/play.html',
      variables: {
        TopMenu: renderTopMenu(geniventureMenuItems, 'play'),
      },

      fileBase: 'play',
      inDirPath: './content/events/2025-06/',
      outDirPath: './_gh-pages/events/2025-06/',
    },
    {
      title: 'Geniventure Hints',
      brief: `Geniventure is designed to be played in a classroom with an instructor. This doc offers background normally provided by a teacher.`,
      url: 'https://EducationalGameClub.com/events/2025-06/hints.html',
      variables: {
        TopMenu: renderTopMenu(geniventureMenuItems, 'hints'),
      },

      fileBase: 'hints',
      inDirPath: './content/events/2025-06/',
      outDirPath: './_gh-pages/events/2025-06/',
    },
    {
      title: 'Rogue Story Trailer',
      brief: `Trailer for François Boucher-Genesse's early-stage prototype of Rogue Story.`,
      url: 'https://EducationalGameClub.com/events/2025-07/trailer.html',
      variables: {
        TopMenu: renderTopMenu(rogueStoryMenuItems, 'trailer'),
      },

      fileBase: 'trailer',
      inDirPath: './content/events/2025-07/',
      outDirPath: './_gh-pages/events/2025-07/',
    },
    {
      title: 'Play Rogue Story',
      brief: `Instructions for playing François Boucher-Genesse's early-stage prototype of Rogue Story.`,
      url: 'https://EducationalGameClub.com/events/2025-07/play.html',
      variables: {
        TopMenu: renderTopMenu(rogueStoryMenuItems, 'play'),
      },

      fileBase: 'play',
      inDirPath: './content/events/2025-07/',
      outDirPath: './_gh-pages/events/2025-07/',
    },
    {
      title: 'Provide Feedback on Rogue Story',
      brief: `Options for providing feedback on François Boucher-Genesse's early-stage prototype of Rogue Story.`,
      url: 'https://EducationalGameClub.com/events/2025-07/feedback.html',
      variables: {
        TopMenu: renderTopMenu(rogueStoryMenuItems, 'feedback'),
      },

      fileBase: 'feedback',
      inDirPath: './content/events/2025-07/',
      outDirPath: './_gh-pages/events/2025-07/',
    },
  ];
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
      isPastEvent: true,

      inDirPath: './content/events/2025-04/',
      outDirPath: './_gh-pages/events/2025-04/',
    },
    {
      uid: '84046b98-08f7-4f09-8039-0bb3afb0f05c',
      title: 'Discussion of Slice Fractions',
      brief: `We'll be discussing Slice Fractions by Ululab, a puzzle game where players learn fraction concepts experientially without verbal or written instructions. Designed for children ages 7 to 12 years.`,
      start: makeUtcDate(2025, 5, 29, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/ktw-hccy-wgm',
      eventUrl: 'https://EducationalGameClub.com/events/2025-05/',
      image: { name: 'image.png', width: 1000, height: 525 },
      isPastEvent: true,

      inDirPath: './content/events/2025-05/',
      outDirPath: './_gh-pages/events/2025-05/',
    },
    {
      uid: '85333bf3-909a-4326-9fd3-4aaeb456f89f',
      title: 'Discussion of Geniventure',
      brief: `We'll be discussing Geniventure by The Concord Consortium, a game where players learn about heredity, genetics, and the protein-to-trait relationship by breeding dragons. Designed for middle and high school students.`,
      start: makeUtcDate(2025, 6, 27, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/kww-yhkj-bqc',
      eventUrl: 'https://EducationalGameClub.com/events/2025-06/',
      image: { name: 'image.jpg', width: 1460, height: 765 },
      topMenu: renderTopMenu(geniventureMenuItems, 'event'),
      isPastEvent: true,

      inDirPath: './content/events/2025-06/',
      outDirPath: './_gh-pages/events/2025-06/',
    },
    {
      uid: '5093b441-911c-4b83-a54a-e9dae7c26626',
      title: 'Playtest & Discussion of Rogue Story',
      brief: `We'll be playtesting and discussing Rogue Story, an early-stage prototype by François Boucher-Genesse. He'll be in attendance and interested in our feedback and ideas about improving the game. A particular focus will be critiquing how the game teaches the player new mechanics.`,
      start: makeUtcDate(2025, 7, 25, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/eqn-brbn-cpu',
      eventUrl: 'https://EducationalGameClub.com/events/2025-07/',
      image: { name: 'image.jpg', width: 1200, height: 623 },
      topMenu: renderTopMenu(rogueStoryMenuItems, 'event'),
      isPastEvent: true,
  
      inDirPath: './content/events/2025-07/',
      outDirPath: './_gh-pages/events/2025-07/',
    },
    {
      uid: '37a5da94-3d47-48c0-98a3-84bd113c2f72',
      title: 'Discussion of Stick and Split',
      brief: `We'll be discussing Stick and Split by Maypole Education, a math game that helps children understand what multiplication and division really mean rather than merely memorizing their times tables.`,
      start: makeUtcDate(2025, 8, 29, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/tds-upgk-uyu',
      eventUrl: 'https://EducationalGameClub.com/events/2025-08/',
      image: { name: 'image.jpeg', width: 955, height: 500 },
      isPastEvent: true,
  
      inDirPath: './content/events/2025-08/',
      outDirPath: './_gh-pages/events/2025-08/',
    },
    {
      uid: '996cb770-55c6-4610-ac89-762ca165e6bb',
      title: 'Discussion of Human Resource Machine',
      brief: `We'll be discussing Human Resource Machine by Tomorrow Corporation, a puzzle game about programming little office workers. It starts with just two commands and gradually builds to more complex concepts.`,
      start: makeUtcDate(2025, 9, 18, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/vyg-jhik-tff',
      eventUrl: 'https://EducationalGameClub.com/events/2025-09/',
      image: { name: 'image.png', width: 1200, height: 630 },
      isPastEvent: true,
  
      inDirPath: './content/events/2025-09/',
      outDirPath: './_gh-pages/events/2025-09/',
    },
    {
      uid: 'a6a08de3-7754-4071-844e-f37c69a78843',
      title: 'Discussion of Zoombinis',
      brief: `We'll be discussing Zoombinis (2015) by TERC, a puzzle game that emphasizes logical reasoning. Solving puzzles requires the player to develop theories, test them, collect evidence based on their successes and failures, and then refine those theories.`,
      start: makeUtcDate(2025, 10, 23, 1),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/fof-xxak-khz',
      eventUrl: 'https://EducationalGameClub.com/events/2025-10/',
      image: { name: 'image.jpg', width: 821, height: 430 },
      isPastEvent: true,
  
      inDirPath: './content/events/2025-10/',
      outDirPath: './_gh-pages/events/2025-10/',
    },
    {
      uid: 'b7261394-d23b-485d-86ca-215ca9ffc7e8',
      title: 'Discussion of Socrates Jones',
      brief: `We'll be discussing Socrates Jones: Pro Philosopher (2013), a game about critical thinking and philosophy. Players explore the nature of morality by debating historical philosophers, from Euthyphro to John Stuart Mill.`,
      start: makeUtcDate(2025, 11, 21, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/tcm-eyhu-ode',
      eventUrl: 'https://EducationalGameClub.com/events/2025-11/',
      image: { name: 'image.jpg', width: 616, height: 323 },
      isPastEvent: true,
  
      inDirPath: './content/events/2025-11/',
      outDirPath: './_gh-pages/events/2025-11/',
    },
    {
      uid: '47d82568-0596-4c98-9b37-f711844eeb81',
      title: 'Discussion of Alba: A Wildlife Adventure',
      brief: `We'll be discussing Alba: A Wildlife Adventure (2020), a game about exploring an island, rescuing its wildlife, and restoring the local nature reserve.`,
      start: makeUtcDate(2025, 12, 17, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/avj-fwwj-jcv',
      eventUrl: 'https://EducationalGameClub.com/events/2025-12/',
      image: { name: 'image.jpg', width: 1200, height: 628 },
      isPastEvent: true,
  
      inDirPath: './content/events/2025-12/',
      outDirPath: './_gh-pages/events/2025-12/',
    },
    {
      uid: 'd405a58b-22f0-468a-b716-8d8f4889a9b8',
      title: 'Discussion of Beats Empire',
      brief: `We'll be discussing Beats Empire (2019), a game about running a music studio: analyze trends and help artists reach the top of the charts. The game is designed to assess data analysis skills (rather than teach them) in middle schools, aligned with widely used US K-12 standards.`,
      start: makeUtcDate(2026, 1, 22, 2),
      duration: { hours: 1, minutes: 30 },
      callUrl: 'https://meet.google.com/hsx-ayrr-abd',
      eventUrl: 'https://EducationalGameClub.com/events/2026-01/',
      image: { name: 'image.png', width: 1200, height: 630 },
      // isPastEvent: true,
  
      inDirPath: './content/events/2026-01/',
      outDirPath: './_gh-pages/events/2026-01/',
    },
  ];
  const nextEvent = events[events.length - 1]; // Assumes they're sorted by ascending date

  await handleVersionTxt({ outDirPath: './_gh-pages/' });

  for (const page of pages) {
    await handlePage(page);
  }

  for (const evt of events) {
    await handleEventPage(evt);
  }

  await handleNextEventPage({
    nextEvent: nextEvent,

    outPath: './_gh-pages/events/next.html',
  });

  const messages = [
    (
      !nextEvent.isPastEvent ? `${style([ANSI.bright], nextEvent.title)} (next event)` :
      `${style([ANSI.fgRed, ANSI.bright], 'No next event')}`
    )
  ];

  if (gitHasLocalChanges()) {
    messages.push(`${style([ANSI.fgRed, ANSI.bright], 'WARNING:')} git has local changes`);
  }

  console.log(`\n${messages.join('\n')}\n`);
}

main();
