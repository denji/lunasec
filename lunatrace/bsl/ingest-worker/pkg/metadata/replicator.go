// Copyright by LunaSec (owned by Refinery Labs, Inc)
//
// Licensed under the Business Source License v1.1
// (the "License"); you may not use this file except in compliance with the
// License. You may obtain a copy of the License at
//
// https://github.com/lunasec-io/lunasec/blob/master/licenses/BSL-LunaTrace.txt
//
// See the License for the specific language governing permissions and
// limitations under the License.
package metadata

import "context"

type Replicator interface {
	GetLastReplicatedOffset() (int, error)
	ReplicateSince(ctx context.Context, since int) error
	InitialReplication(ctx context.Context) error
}

type APIReplicator interface {
	ReplicatePackages(packages []string) error
	ReplicateFromStreamWithBackoff(packages <-chan string, versionCounts, ignoreErrors bool) error
}
