import type { request as RequestT } from "undici";

import boxen from "boxen";
import chalk from "chalk";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import semver from "semver";

import { getCacheDir } from "../util/global-dir";
import { getHardhatVersion } from "../util/packageInfo";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_OWNER = "NomicFoundation";
const GITHUB_REPO = "hardhat";
const V3_RELEASE_TAG = "hardhat@3.0.0";
const V3_RELEASE_VERSION_NOTIFIER_ASSET_NAME = "version-notifier-message.txt";
const V3_RELEASE_MAX_TIMES_SHOWN = 5;

const boxenOptions = {
  padding: 1,
  borderStyle: "round",
  borderColor: "yellow",
} as const;

interface VersionNotifierCache {
  lastCheck: string | 0;
  v3TimesShown: number;
  v3Release?: Release;
  v3ReleaseMessage?: string;
}

/* eslint-disable @typescript-eslint/naming-convention */
interface Release {
  name: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
  body: string; // release notes
}
/* eslint-enable @typescript-eslint/naming-convention */

export async function showNewVersionNotification() {
  const cache = await readCache();

  const lastCheckDate = new Date(cache.lastCheck);
  const now = new Date();
  const oneDay = 1000 * 60 * 60 * 24;

  if (now.getTime() - lastCheckDate.getTime() < oneDay) {
    return;
  }

  const hardhatVersion = getHardhatVersion();

  const releases = await getReleases();

  const latestV2Release = releases.find((release) => {
    if (release.draft || release.prerelease) {
      return false;
    }

    const [packageName, packageVersion] = release.tag_name.split("@");

    return (
      packageName === GITHUB_REPO &&
      semver.valid(packageVersion) !== null &&
      semver.major(packageVersion) === 2
    );
  });

  const v3Release = cache.v3Release ?? (await getV3Release());

  if (latestV2Release === undefined && v3Release === undefined) {
    // this should never happen unless the github api is down
    return;
  }

  if (latestV2Release !== undefined) {
    const releaseVersion = semver.valid(latestV2Release.tag_name.split("@")[1]);

    if (releaseVersion !== null && semver.gt(releaseVersion, hardhatVersion)) {
      console.log(
        boxen(
          `New Hardhat release available! ${chalk.red(
            hardhatVersion
          )} -> ${chalk.green(releaseVersion)}.

Changelog: https://hardhat.org/release/${releaseVersion}

Run "npm install hardhat@latest" to update.`,
          boxenOptions
        )
      );
    }
  }

  if (v3Release !== undefined) {
    const releaseVersion = semver.valid(v3Release.tag_name.split("@")[1]);

    if (releaseVersion !== null) {
      if (cache.v3TimesShown < V3_RELEASE_MAX_TIMES_SHOWN) {
        cache.v3ReleaseMessage =
          cache.v3ReleaseMessage ?? (await getV3ReleaseMessage(v3Release));
        if (cache.v3ReleaseMessage !== undefined) {
          console.log(boxen(cache.v3ReleaseMessage, boxenOptions));
          cache.v3TimesShown++;
        }
      }
    }
  }

  await writeCache({
    ...cache,
    lastCheck: now.toISOString(),
    v3Release,
  });
}

async function readCache(): Promise<VersionNotifierCache> {
  const cacheDir = await getCacheDir();
  const versionNotifierCachePath = join(cacheDir, "version-notifier.json");

  let cache: VersionNotifierCache = {
    lastCheck: 0, // new Date(0) represents the unix epoch
    v3TimesShown: 0,
  };
  try {
    const fileContents = await readFile(versionNotifierCachePath, "utf-8");
    const { lastCheck, v3TimesShown } = JSON.parse(fileContents);

    cache = {
      lastCheck: typeof lastCheck === "string" ? lastCheck : 0,
      v3TimesShown: typeof v3TimesShown === "number" ? v3TimesShown : 0,
    };
  } catch (error: any) {
    // We don't care if it fails
  }

  return cache;
}

async function writeCache(cache: VersionNotifierCache) {
  const cacheDir = await getCacheDir();
  const versionNotifierCachePath = join(cacheDir, "version-notifier.json");

  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(versionNotifierCachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    // We don't care if it fails
  }
}

async function getReleases(): Promise<Release[]> {
  const { request } = (await import("undici")) as { request: typeof RequestT };
  let releases: Release[] = [];

  try {
    const githubResponse = await request(
      `${GITHUB_API_URL}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      {
        method: "GET",
        headers: {
          "User-Agent": "Hardhat",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        query: {
          per_page: 100,
        },
      }
    );
    releases = (await githubResponse.body.json()) as Release[];
  } catch (error: any) {
    // We don't care if it fails
  }

  releases.sort(
    (a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  return releases;
}

async function getV3Release(): Promise<Release | undefined> {
  const { request } = (await import("undici")) as { request: typeof RequestT };
  let v3Release: Release | undefined;

  try {
    const githubResponse = await request(
      `${GITHUB_API_URL}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${V3_RELEASE_TAG}`,
      {
        method: "GET",
        headers: {
          "User-Agent": "Hardhat",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    const jsonResponse = (await githubResponse.body.json()) as any;
    if (jsonResponse.message === "Not Found") {
      // eslint-disable-next-line @nomicfoundation/hardhat-internal-rules/only-hardhat-error
      throw new Error("Not Found");
    }

    v3Release = jsonResponse as Release;
  } catch (error: any) {
    // We don't care if it fails
  }

  return v3Release;
}

async function getV3ReleaseMessage(
  v3Release: Release
): Promise<string | undefined> {
  const { request } = (await import("undici")) as { request: typeof RequestT };

  const versionNotifierAsset = v3Release.assets.find(
    ({ name }) => name === V3_RELEASE_VERSION_NOTIFIER_ASSET_NAME
  );

  if (versionNotifierAsset === undefined) {
    return;
  }

  let v3ReleaseMessage;
  try {
    const githubResponse = await request(
      versionNotifierAsset.browser_download_url,
      {
        method: "GET",
        maxRedirections: 10,
      }
    );

    v3ReleaseMessage = await githubResponse.body.text();
  } catch (error: any) {
    // We don't care if it fails
  }

  return v3ReleaseMessage;
}
