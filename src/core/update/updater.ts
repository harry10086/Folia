export const APP_VERSION = "0.1.2";
export const APP_AUTHOR = "harry";
export const APP_AUTHOR_URL = "https://mianao.info";
export const APP_LICENSE = "GPLv3";
export const GITHUB_REPO_OWNER = "harry10086";
export const GITHUB_REPO_NAME = "Folia";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

export interface UpdateCheckResult {
  status: "update-available" | "up-to-date" | "no-release" | "error";
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl: string;
  publishedAt?: string;
  notes?: string;
  errorMessage?: string;
}

/**
 * Compare two semver strings (e.g. "v0.2.0" vs "0.1.0").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export async function checkGithubUpdate(): Promise<UpdateCheckResult> {
  try {
    const resp = await fetch(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (resp.status === 404) {
      return {
        status: "no-release",
        currentVersion: APP_VERSION,
        releaseUrl: GITHUB_RELEASES_URL,
      };
    }

    if (!resp.ok) {
      return {
        status: "error",
        currentVersion: APP_VERSION,
        releaseUrl: GITHUB_RELEASES_URL,
        errorMessage: `GitHub API 返回状态 ${resp.status}`,
      };
    }

    const data = (await resp.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
    };

    const latestTag = (data.tag_name || data.name || "").trim();
    const releaseUrl = data.html_url || GITHUB_RELEASES_URL;
    if (!latestTag) {
      return {
        status: "no-release",
        currentVersion: APP_VERSION,
        releaseUrl,
      };
    }

    const cmp = compareSemver(latestTag, APP_VERSION);
    return {
      status: cmp > 0 ? "update-available" : "up-to-date",
      currentVersion: APP_VERSION,
      latestVersion: latestTag.startsWith("v") ? latestTag : `v${latestTag}`,
      releaseName: data.name || latestTag,
      releaseUrl,
      publishedAt: data.published_at,
      notes: data.body?.trim(),
    };
  } catch (err) {
    return {
      status: "error",
      currentVersion: APP_VERSION,
      releaseUrl: GITHUB_RELEASES_URL,
      errorMessage: err instanceof Error ? err.message : "网络连接失败",
    };
  }
}
