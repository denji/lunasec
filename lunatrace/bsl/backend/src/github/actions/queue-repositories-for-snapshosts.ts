/*
 * Copyright by LunaSec (owned by Refinery Labs, Inc)
 *
 * Licensed under the Business Source License v1.1 
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 *
 * https://github.com/lunasec-io/lunasec/blob/master/licenses/BSL-LunaTrace.txt
 *
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import { GithubRepositoryInfo } from "../../types/github";
import {MaybeError} from "../../types/util";
import {newError, newResult} from "../../utils/errors";
import {log} from "../../utils/log";
import {catchError, threwError} from "../../utils/try";
import {queueRepositoryForSnapshot} from "../../workers/queue-repository-for-snapshot";
import {generateGithubGraphqlClient} from "../api";
import {getInstallationAccessToken} from "../auth";

import {generateSnapshotForRepository} from "./generate-snapshot-for-repository";
import {hydrateRepositoryInformation} from "./hydrate-repository-information";

export async function queueGithubReposForSnapshots(installationId: number, githubRepos: GithubRepositoryInfo[]): Promise<MaybeError<undefined>> {
  const installationToken = await getInstallationAccessToken(installationId);

  if (installationToken.error) {
    const msg = 'unable to get installation token';
    log.error(msg, {
      error: installationToken.msg
    });
    return newError(msg);
  }

  const results = await Promise.all(githubRepos.map(async (repo): Promise<MaybeError<undefined>> => {
    await hydrateRepositoryInformation(installationToken.res, repo);

    if (!repo.cloneUrl || !repo.defaultBranch) {
      const msg = 'unable to generate snapshot for repository, required fields are missing';
      log.error(msg, {
        repo
      })
      return newError(msg);
    }

    await queueRepositoryForSnapshot({
      cloneUrl: repo.cloneUrl,
      gitBranch: repo.defaultBranch,
      installationId: installationId,
      repoGithubId: repo.repoId,
      sourceType: 'gui'
    })
    return newResult(undefined);
  }));

  const errors = results.filter(res => res.error);
  if (errors.length > 0) {
    return newError(JSON.stringify(errors))
  }

  return newResult(undefined);
}
