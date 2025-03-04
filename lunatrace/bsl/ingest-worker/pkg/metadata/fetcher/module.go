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
package fetcher

import (
	"github.com/lunasec-io/lunasec/lunatrace/bsl/ingest-worker/pkg/metadata/fetcher/npm"
	"go.uber.org/fx"
)

var NPMModule = fx.Options(
	fx.Provide(
		npm.NewConfig,
		npm.NewNPMFetcher,
	),
)
