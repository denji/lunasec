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
import { getCvssVectorFromSeverities } from '@lunatrace/lunatrace-common/build/main/cvss';
import React from 'react';
import { Card, Col, OverlayTrigger, Row, Table, Tooltip } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';

import { VulnInfoDetails } from '../types';

export const EquivalentVulnerabilitiesList: React.FC<{ relatedVulns: VulnInfoDetails['equivalents'] }> = ({
  relatedVulns,
}) => {
  const navigate = useNavigate();

  return (
    <Row>
      <Col xs="12">
        <Card>
          <Card.Body>
            <Card.Title>Related Vulnerabilities</Card.Title>
            <Table size="sm" hover>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Vulnerability ID</th>
                  <th>Severity</th>
                  <th>CVSS</th>
                </tr>
              </thead>
              <tbody>
                {relatedVulns.map(({ equivalent_vulnerability: relatedVuln }) => {
                  const severity = getCvssVectorFromSeverities(relatedVuln.severities);

                  if (!relatedVuln.last_fetched) {
                    return (
                      <tr key={relatedVuln.id}>
                        <td>{relatedVuln.source}</td>
                        <td>{relatedVuln.source_id}</td>
                        <td>Not Synced</td>
                        <td>Not Synced</td>
                      </tr>
                    );
                  }
                  return (
                    <OverlayTrigger
                      placement="bottom"
                      overlay={<Tooltip className="wide-tooltip"> {relatedVuln.summary}</Tooltip>}
                      key={relatedVuln.id}
                    >
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/vulnerabilities/${relatedVuln.id as string}`)}
                      >
                        <td>{relatedVuln.source}</td>
                        <td>{relatedVuln.source_id}</td>
                        <td>{severity ? severity.cvss3OverallSeverityText : 'unknown'}</td>
                        <td>{severity ? severity.overallScore : 'unknown'}</td>
                      </tr>
                    </OverlayTrigger>
                  );
                })}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
};
