// RS256 JWT Signer sidecar for PocketBase 0.39 (vendored from repo tooling)
// Listens on localhost:9999, signs JWTs with RSA private keys.
//
//   go run ./scripts/signer   (or: go build -o bin/signer ./scripts/signer)
//
// Endpoint:  POST http://localhost:9999/sign
//   body:    { "claim": { ...jwt claims... }, "privateKey": "-----BEGIN PRIVATE KEY-----\n..." }
//   resp:    { "signedJwt": "eyJ..." }
//
// gw-mailbox uses this because PocketBase 0.39 removed the old rsaSign helper;
// when the sidecar is down it transparently falls back to local `openssl`.
package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type SignRequest struct {
	Claim      map[string]interface{} `json:"claim"`
	PrivateKey string                 `json:"privateKey"`
}

type SignResponse struct {
	SignedJWT string `json:"signedJwt"`
	Error     string `json:"error,omitempty"`
}

func base64URLEncode(data []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(data), "=")
}

func signJWT(claim map[string]interface{}, privateKeyPEM string) (string, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return "", fmt.Errorf("failed to parse PEM block")
	}

	var key *rsa.PrivateKey
	var err error

	switch block.Type {
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return "", fmt.Errorf("failed to parse PKCS8: %v", e)
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("key is not RSA")
		}
	default:
		return "", fmt.Errorf("unsupported key type: %s", block.Type)
	}
	if err != nil {
		return "", fmt.Errorf("failed to parse key: %v", err)
	}

	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	headerJSON, _ := json.Marshal(header)
	claimJSON, _ := json.Marshal(claim)

	encHeader := base64URLEncode(headerJSON)
	encPayload := base64URLEncode(claimJSON)
	toSign := encHeader + "." + encPayload

	hasher := crypto.SHA256.New()
	hasher.Write([]byte(toSign))
	hash := hasher.Sum(nil)

	sig, err := rsa.SignPKCS1v15(nil, key, crypto.SHA256, hash)
	if err != nil {
		return "", fmt.Errorf("signing failed: %v", err)
	}

	encSig := base64URLEncode(sig)
	return toSign + "." + encSig, nil
}

func main() {
	http.HandleFunc("/sign", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, `{"error":"POST required"}`, 405)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":"read body failed"}`, 400)
			return
		}

		var req SignRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, `{"error":"invalid JSON"}`, 400)
			return
		}

		jwt, err := signJWT(req.Claim, req.PrivateKey)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(SignResponse{Error: err.Error()})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SignResponse{SignedJWT: jwt})
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	})

	fmt.Println("RS256 JWT Signer listening on :9999")
	if err := http.ListenAndServe(":9999", nil); err != nil {
		fmt.Printf("Server error: %v\n", err)
	}
}
