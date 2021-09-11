package gateway

import (
	"crypto/md5"
	"encoding/base64"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/refinery-labs/loq/constants"
	"go.uber.org/config"
	"go.uber.org/zap"
	"io/ioutil"
	"log"
	"strings"
)

const s3EncryptionAlgo = "AES256"

type awsS3Gateway struct {
	AwsS3GatewayConfig
	logger *zap.Logger
	s3     *session.Session
	s3Host string
}

type AwsS3GatewayConfig struct {
	S3Region string `yaml:"region"`
	AccessKeyID string `yaml:"access_key_id"`
	SecretAccessKey string `yaml:"secret_access_key"`
	LocalstackURL string `yaml:"localstack_url"`
	LocalHTTPSProxy string `yaml:"local_https_proxy"`
	S3Bucket string `yaml:"s3_bucket"`
}

type AwsS3GatewayConfigWrapper struct {
	AwsGateway AwsS3GatewayConfig `yaml:"aws_gateway"`
}

// AwsS3Gateway ...
type AwsS3Gateway interface {
	GetObject(key string) (content []byte, err error)
	GeneratePresignedGetUrl(key string, encryptionKey []byte) (string, map[string]string, error)
	GeneratePresignedPutUrl(key string, encryptionKey []byte) (string, map[string]string, error)
}

func NewAwsS3GatewayConfig(region, bucket string) AwsS3GatewayConfigWrapper {
	return AwsS3GatewayConfigWrapper{
		AwsGateway: AwsS3GatewayConfig{
			S3Region: region,
			S3Bucket: bucket,
		},
	}
}

// TODO (cthompson) this should just be a presigning service since local dev presigns urls with an endpoint URL
// that would not work if attempting to contact s3 directly from this service. Another S3 gateway for calls
// directly to s3 from this service should be created.

// NewAwsS3Gateway...
func NewAwsS3Gateway(logger *zap.Logger, provider config.Provider, sess *session.Session) (s3Gateway AwsS3Gateway) {
	var (
		gatewayConfig AwsS3GatewayConfig
	)

	err := provider.Get("aws_gateway").Populate(&gatewayConfig)
	if err != nil {
		logger.Error("unable to populate s3 config", zap.Error(err))
		panic(err)
	}

	s3Host := gatewayConfig.S3Bucket + ".s3.us-west-2.amazonaws.com"

	s3Gateway = &awsS3Gateway{
		logger:             logger,
		AwsS3GatewayConfig: gatewayConfig,
		s3:                 sess,
		s3Host:             s3Host,
	}
	return
}

func (s *awsS3Gateway) GetObject(key string) (content []byte, err error) {
	s3Client := s3.New(s.s3)
	input := s3.GetObjectInput{
		Bucket: aws.String(s.S3Bucket),
		Key:    aws.String(key),
	}
	resp, err := s3Client.GetObject(&input)
	if err != nil {
		log.Println(err)
		return
	}
	defer resp.Body.Close()

	return ioutil.ReadAll(resp.Body)
}

type createPresignedUrlParams struct {
	svc *s3.S3
	bucket, key string
	encryptionKey []byte
	encodedKeyChecksum string
}

type createPresignedUrlFunc func(params createPresignedUrlParams) (url string, err error)

// adjustUrlFromLocalDev will re-write the URL so that they can be accessed without an https cert in a browser when testing locally.
func (s *awsS3Gateway) adjustUrlFromLocalDev(url string) string {
	s.logger.Debug(
		"adjusting url for local dev",
		zap.String("https proxy", s.LocalHTTPSProxy),
		zap.String("localstack url", s.LocalstackURL),
	)

	return strings.ReplaceAll(url, s.LocalHTTPSProxy, s.LocalstackURL)
}

func (s *awsS3Gateway) GeneratePresignedPutUrl(key string, encryptionKey []byte) (string, map[string]string, error) {
	return s.generatePresignedUrl(key, encryptionKey, createPutObjectPresignedUrl)
}

func (s *awsS3Gateway) GeneratePresignedGetUrl(key string, encryptionKey []byte) (string, map[string]string, error) {
	return s.generatePresignedUrl(key, encryptionKey, createGetObjectPresignedUrl)
}

func (s *awsS3Gateway) generatePresignedUrl(key string, encryptionKey []byte, createPresignedUrl createPresignedUrlFunc) (string, map[string]string, error) {
	svc := s3.New(s.s3)
	b64EncryptionKey := base64.StdEncoding.EncodeToString(encryptionKey)
	keyChecksum := md5.Sum(encryptionKey)
	keyChecksumBase64 := base64.StdEncoding.EncodeToString(keyChecksum[:])

	params := createPresignedUrlParams{
		svc, s.S3Bucket, key, encryptionKey, keyChecksumBase64,
	}

	url, err := createPresignedUrl(params)

	if err != nil {
		return "", nil, err
	}

	headers := map[string]string{
		"host": s.s3Host,
		"x-amz-server-side-encryption-customer-key":       b64EncryptionKey,
		"x-amz-server-side-encryption-customer-key-md5":   keyChecksumBase64,
		"x-amz-server-side-encryption-customer-algorithm": s3EncryptionAlgo,
	}

	if s.LocalHTTPSProxy != "" {
		url = s.adjustUrlFromLocalDev(url)
	}

	return url, headers, err
}

func createGetObjectPresignedUrl(params createPresignedUrlParams) (url string, err error) {
	req, _ := params.svc.GetObjectRequest(&s3.GetObjectInput{
		Bucket:               aws.String(params.bucket),
		Key:                  aws.String(params.key),
		SSECustomerAlgorithm: aws.String(s3EncryptionAlgo),
		SSECustomerKey:       aws.String(string(params.encryptionKey)),
		SSECustomerKeyMD5:    aws.String(params.encodedKeyChecksum),
	})
	return req.Presign(constants.S3Timeout)
}

func createPutObjectPresignedUrl(params createPresignedUrlParams) (url string, err error) {
	req, _ := params.svc.PutObjectRequest(&s3.PutObjectInput{
		Bucket:               aws.String(params.bucket),
		Key:                  aws.String(params.key),
		SSECustomerAlgorithm: aws.String(s3EncryptionAlgo),
		SSECustomerKey:       aws.String(string(params.encryptionKey)),
		SSECustomerKeyMD5:    aws.String(params.encodedKeyChecksum),
	})

	return req.Presign(constants.S3Timeout)
}
