//! VANTA Rust SDK
//!
//! Private intent execution for Solana.
//!
//! # Example
//! ```no_run
//! use vanta_sdk::VantaClient;
//!
//! #[tokio::main]
//! async fn main() {
//!     let client = VantaClient::new("https://api.mainnet-beta.solana.com")
//!         .with_relay("https://relay-1.usevanta.xyz")
//!         .build();
//!
//!     // Submit encrypted intent
//!     let result = client.submit_swap(
//!         "So11111111111111111111111111111111111111112",
//!         "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
//!         1_000_000_000,
//!         0.5,
//!     ).await.unwrap();
//! }
//! ```

use thiserror::Error;

#[derive(Error, Debug)]
pub enum VantaError {
    #[error("encryption failed: {0}")]
    Encryption(String),
    #[error("relay unreachable: {0}")]
    RelayError(String),
    #[error("invalid intent: {0}")]
    InvalidIntent(String),
    #[error("MEV risk too high: {score}")]
    MevRisk { score: f64 },
}

pub type Result<T> = std::result::Result<T, VantaError>;

pub struct VantaClient {
    _rpc_url: String,
    _relay_urls: Vec<String>,
}

impl VantaClient {
    pub fn new(rpc_url: &str) -> VantaClientBuilder {
        VantaClientBuilder {
            rpc_url: rpc_url.to_string(),
            relay_urls: Vec::new(),
        }
    }
}

pub struct VantaClientBuilder {
    rpc_url: String,
    relay_urls: Vec<String>,
}

impl VantaClientBuilder {
    pub fn with_relay(mut self, url: &str) -> Self {
        self.relay_urls.push(url.to_string());
        self
    }

    pub fn build(self) -> VantaClient {
        VantaClient {
            _rpc_url: self.rpc_url,
            _relay_urls: self.relay_urls,
        }
    }
}

// TODO: Implement submit_swap, submit_transfer, etc.
// See TypeScript reference implementation in src/sdk/client.ts
