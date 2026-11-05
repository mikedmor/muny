/**
 * Paid services → self-hosted / free and open-source alternatives.
 *
 * Shipped as data (no network calls). Community contributions welcome: keep
 * entries factual, link to the project's own site, and say honestly what you
 * give up ("tradeoff"). `match` is tested against merchant names (lowercase).
 */

export type AlternativeKind = "self-hosted" | "open-source app" | "free";

export interface Alternative {
  name: string;
  url: string;
  kind: AlternativeKind;
  /** Rough setup effort for someone with a NAS and Docker. */
  effort: "low" | "medium" | "high";
  note?: string;
}

export interface CatalogEntry {
  service: string;
  match: RegExp;
  category: string;
  alternatives: Alternative[];
  /** What you give up by switching. */
  tradeoff?: string;
}

const a = (
  name: string,
  url: string,
  kind: AlternativeKind,
  effort: Alternative["effort"],
  note?: string,
): Alternative => ({ name, url, kind, effort, ...(note ? { note } : {}) });

const JELLYFIN = a(
  "Jellyfin",
  "https://jellyfin.org",
  "self-hosted",
  "medium",
  "Stream your own movies and shows",
);
const PLEX = a(
  "Plex (free tier)",
  "https://www.plex.tv",
  "self-hosted",
  "low",
  "Free server; Plex Pass optional",
);
const NAVIDROME = a(
  "Navidrome",
  "https://www.navidrome.org",
  "self-hosted",
  "low",
  "Stream your own music library",
);
const NEXTCLOUD = a(
  "Nextcloud",
  "https://nextcloud.com",
  "self-hosted",
  "medium",
  "Files, calendar, contacts",
);
const SYNO_DRIVE = a(
  "Synology Drive",
  "https://www.synology.com/en-us/dsm/feature/drive",
  "self-hosted",
  "low",
  "Built into DSM",
);
const IMMICH = a(
  "Immich",
  "https://immich.app",
  "self-hosted",
  "medium",
  "Google Photos-like app with phone backup",
);
const VAULTWARDEN = a(
  "Vaultwarden",
  "https://github.com/dani-garcia/vaultwarden",
  "self-hosted",
  "low",
  "Works with the Bitwarden apps",
);

export const ALTERNATIVES_CATALOG: CatalogEntry[] = [
  {
    service: "Netflix",
    match: /netflix/,
    category: "Streaming video",
    alternatives: [JELLYFIN, PLEX],
    tradeoff: "Only plays media you already own or record; no Netflix originals.",
  },
  {
    service: "Hulu / Disney+ / Max / Paramount+ / Peacock",
    match: /hulu|disney\s?\+|disneyplus|\bhbo\b|\bmax\b|paramount|peacock/,
    category: "Streaming video",
    alternatives: [JELLYFIN, PLEX],
    tradeoff: "Only plays media you own; consider rotating one service at a time instead.",
  },
  {
    service: "Spotify / Apple Music / YouTube Music",
    match: /spotify|apple music|youtube music|tidal|pandora/,
    category: "Music",
    alternatives: [
      NAVIDROME,
      a("Jellyfin (music)", "https://jellyfin.org", "self-hosted", "medium"),
    ],
    tradeoff: "Your own library only; no discovery playlists or new releases.",
  },
  {
    service: "Audible",
    match: /audible/,
    category: "Audiobooks",
    alternatives: [
      a(
        "Audiobookshelf",
        "https://www.audiobookshelf.org",
        "self-hosted",
        "low",
        "Audiobooks and podcasts with progress sync",
      ),
      a(
        "Libby (library)",
        "https://libbyapp.com",
        "free",
        "low",
        "Borrow audiobooks free with a library card",
      ),
    ],
  },
  {
    service: "Kindle Unlimited",
    match: /kindle unltd|kindle unlimited/,
    category: "E-books",
    alternatives: [
      a("Calibre-Web", "https://github.com/janeczku/calibre-web", "self-hosted", "low"),
      a("Kavita", "https://www.kavitareader.com", "self-hosted", "low"),
      a("Libby (library)", "https://libbyapp.com", "free", "low"),
    ],
  },
  {
    service: "Google Photos / iCloud+ / Amazon Photos",
    match: /google ?one|google storage|icloud|amazon photos/,
    category: "Photos & cloud storage",
    alternatives: [
      IMMICH,
      a(
        "Synology Photos",
        "https://www.synology.com/en-us/dsm/feature/photos",
        "self-hosted",
        "low",
        "Built into DSM",
      ),
      NEXTCLOUD,
    ],
    tradeoff: "You're responsible for backups (keep an off-site copy, e.g. Hyper Backup).",
  },
  {
    service: "Dropbox / Box / OneDrive",
    match: /dropbox|\bbox\.com|onedrive/,
    category: "File sync",
    alternatives: [
      SYNO_DRIVE,
      NEXTCLOUD,
      a("Syncthing", "https://syncthing.net", "open-source app", "low"),
    ],
  },
  {
    service: "1Password / LastPass / Dashlane",
    match: /1password|lastpass|dashlane|keeper/,
    category: "Passwords",
    alternatives: [
      VAULTWARDEN,
      a("Bitwarden (free)", "https://bitwarden.com", "free", "low"),
      a("KeePassXC", "https://keepassxc.org", "open-source app", "low"),
    ],
    tradeoff: "Self-hosting passwords means your NAS must be reachable and well backed up.",
  },
  {
    service: "Evernote / Notion",
    match: /evernote|notion/,
    category: "Notes",
    alternatives: [
      a(
        "Joplin",
        "https://joplinapp.org",
        "open-source app",
        "low",
        "Sync through Nextcloud or WebDAV",
      ),
      a("Trilium Notes", "https://github.com/TriliumNext/Notes", "self-hosted", "low"),
      a("AppFlowy", "https://appflowy.io", "open-source app", "medium", "Notion-like"),
    ],
  },
  {
    service: "Todoist / TickTick",
    match: /todoist|ticktick/,
    category: "Tasks",
    alternatives: [a("Vikunja", "https://vikunja.io", "self-hosted", "low")],
  },
  {
    service: "Trello / Asana / Monday",
    match: /trello|asana|monday\.com/,
    category: "Project boards",
    alternatives: [
      a("Planka", "https://planka.app", "self-hosted", "low"),
      a("WeKan", "https://wekan.github.io", "self-hosted", "low"),
    ],
  },
  {
    service: "Microsoft 365",
    match: /microsoft 365|msft \*|microsoft\*|office 365/,
    category: "Office",
    alternatives: [
      a("LibreOffice", "https://www.libreoffice.org", "open-source app", "low"),
      a(
        "OnlyOffice Docs",
        "https://www.onlyoffice.com",
        "self-hosted",
        "medium",
        "Online editing with Nextcloud",
      ),
    ],
    tradeoff: "Check whether the 1 TB OneDrive storage is what you actually use it for.",
  },
  {
    service: "Adobe Creative Cloud",
    match: /adobe/,
    category: "Creative",
    alternatives: [
      a("darktable", "https://www.darktable.org", "open-source app", "medium", "Lightroom-like"),
      a("GIMP / Krita", "https://www.gimp.org", "open-source app", "medium"),
      a("Inkscape", "https://inkscape.org", "open-source app", "medium"),
      a(
        "DaVinci Resolve (free)",
        "https://www.blackmagicdesign.com/products/davinciresolve",
        "free",
        "medium",
      ),
    ],
    tradeoff: "Different workflows; pros sharing files with Adobe users may need to stay.",
  },
  {
    service: "Canva Pro",
    match: /canva/,
    category: "Design",
    alternatives: [a("Penpot", "https://penpot.app", "self-hosted", "medium")],
  },
  {
    service: "Grammarly",
    match: /grammarly/,
    category: "Writing",
    alternatives: [
      a(
        "LanguageTool (self-hosted)",
        "https://languagetool.org",
        "self-hosted",
        "low",
        "Browser extension can point at your server",
      ),
    ],
  },
  {
    service: "ChatGPT Plus / Claude Pro / other AI chat",
    match: /openai|chatgpt|anthropic|claude\.ai|perplexity/,
    category: "AI",
    alternatives: [
      a(
        "Open WebUI + Ollama",
        "https://openwebui.com",
        "self-hosted",
        "medium",
        "Local models; needs a capable GPU for good results",
      ),
    ],
    tradeoff: "Local models are much weaker than frontier models on a NAS-class machine.",
  },
  {
    service: "Ring / Nest Aware / Arlo",
    match: /\bring\b|ring\.com|\bnest\b|nest aware|arlo|simplisafe/,
    category: "Home cameras",
    alternatives: [
      a("Frigate", "https://frigate.video", "self-hosted", "high", "Local recording and detection"),
      a(
        "Synology Surveillance Station",
        "https://www.synology.com/en-us/surveillance",
        "self-hosted",
        "medium",
        "2 free camera licenses on DSM",
      ),
    ],
    tradeoff: "Needs compatible (usually RTSP) cameras.",
  },
  {
    service: "SmartThings / Alexa / Google Home subscriptions",
    match: /smartthings|alexa\+|google home premium/,
    category: "Smart home",
    alternatives: [a("Home Assistant", "https://www.home-assistant.io", "self-hosted", "medium")],
  },
  {
    service: "Rocket Money / YNAB / Monarch",
    match: /rocket money|truebill|ynab|you need a budget|monarch/,
    category: "Budgeting",
    alternatives: [
      a("Muny", "https://github.com/mikedmor/muny", "self-hosted", "low", "You're using it"),
      a("Actual Budget", "https://actualbudget.org", "self-hosted", "low"),
      a("Firefly III", "https://www.firefly-iii.org", "self-hosted", "medium"),
    ],
  },
  {
    service: "Zoom / Webex",
    match: /zoom\.us|zoom video|webex/,
    category: "Video calls",
    alternatives: [a("Jitsi Meet", "https://jitsi.org", "self-hosted", "medium")],
  },
  {
    service: "Slack / Discord Nitro",
    match: /slack|discord/,
    category: "Chat",
    alternatives: [
      a("Mattermost", "https://mattermost.com", "self-hosted", "medium"),
      a("Element (Matrix)", "https://element.io", "self-hosted", "high"),
    ],
  },
  {
    service: "Squarespace / Wix",
    match: /squarespace|wix\.com/,
    category: "Websites",
    alternatives: [
      a("Ghost", "https://ghost.org", "self-hosted", "medium"),
      a("WordPress", "https://wordpress.org", "self-hosted", "medium"),
    ],
    tradeoff: "A public website on your home network needs extra care (reverse proxy, updates).",
  },
  {
    service: "Mailchimp",
    match: /mailchimp|intuit mailchimp/,
    category: "Newsletters",
    alternatives: [
      a(
        "listmonk",
        "https://listmonk.app",
        "self-hosted",
        "medium",
        "Still needs an email sending service",
      ),
    ],
  },
  {
    service: "Calendly",
    match: /calendly/,
    category: "Scheduling",
    alternatives: [a("Cal.com", "https://cal.com", "self-hosted", "medium")],
  },
  {
    service: "Zapier / IFTTT",
    match: /zapier|ifttt/,
    category: "Automation",
    alternatives: [
      a("n8n", "https://n8n.io", "self-hosted", "medium"),
      a("Node-RED", "https://nodered.org", "self-hosted", "medium"),
    ],
  },
  {
    service: "Pocket / Instapaper",
    match: /pocket|instapaper/,
    category: "Read later",
    alternatives: [
      a("Wallabag", "https://wallabag.org", "self-hosted", "low"),
      a("linkding", "https://github.com/sissbruecker/linkding", "self-hosted", "low"),
    ],
  },
  {
    service: "Feedly / Inoreader",
    match: /feedly|inoreader/,
    category: "News feeds",
    alternatives: [
      a("FreshRSS", "https://freshrss.org", "self-hosted", "low"),
      a("Miniflux", "https://miniflux.app", "self-hosted", "low"),
    ],
  },
  {
    service: "Pushover / Pushbullet",
    match: /pushover|pushbullet/,
    category: "Notifications",
    alternatives: [
      a("ntfy", "https://ntfy.sh", "self-hosted", "low", "Muny can send alerts to it"),
    ],
  },
  {
    service: "Google Analytics / paid analytics",
    match: /plausible|fathom|simple analytics/,
    category: "Web analytics",
    alternatives: [
      a("Umami", "https://umami.is", "self-hosted", "low"),
      a("Plausible CE", "https://plausible.io/self-hosted-web-analytics", "self-hosted", "medium"),
    ],
  },
  {
    service: "Backblaze / Carbonite / IDrive",
    match: /backblaze|carbonite|idrive/,
    category: "Backups",
    alternatives: [
      a(
        "Synology Active Backup",
        "https://www.synology.com/en-us/dsm/feature/active_backup_business",
        "self-hosted",
        "low",
        "Back up PCs to the NAS",
      ),
    ],
    tradeoff: "Keep at least one off-site copy; a NAS alone isn't a full backup.",
  },
  {
    service: "Ad-free / tracker blocking subscriptions",
    match: /adguard|nextdns/,
    category: "Network",
    alternatives: [
      a("Pi-hole", "https://pi-hole.net", "self-hosted", "low"),
      a("AdGuard Home", "https://adguard.com/en/adguard-home/overview.html", "self-hosted", "low"),
    ],
  },
];

/** Catalog entries matching a merchant/series name. */
export function findAlternatives(name: string): CatalogEntry[] {
  const n = name.toLowerCase();
  return ALTERNATIVES_CATALOG.filter((e) => e.match.test(n));
}
