import { 
  getClient, 
  getRedundantClients, 
  testAllRpcConnections,
  refreshRpcEndpoints 
} from "../constants";
import { executeWithRetry, createRetryClient } from "../rpcRetryWrapper";
import { rpcClientManager } from "../rpcClientManager";

async function testRpcConnections() {
  console.log("🔧 Testing RPC Connection System\n");

  // Test 1: Test all RPC endpoints
  console.log("1️⃣ Testing all configured RPC endpoints...");
  try {
    const connectionStatus = await testAllRpcConnections();
    
    for (const [chainId, results] of Object.entries(connectionStatus)) {
      console.log(`\nChain ID ${chainId}:`);
      results.forEach((result) => {
        const status = result.success ? "✅" : "❌";
        const latency = result.latency ? `${result.latency}ms` : "N/A";
        console.log(`  ${status} ${result.endpoint.url.substring(0, 50)}... - ${latency}`);
        if (!result.success && result.error) {
          console.log(`     Error: ${result.error}`);
        }
      });
    }
  } catch (error) {
    console.error("Failed to test connections:", error);
  }

  // Test 2: Get optimized client for Ethereum
  console.log("\n2️⃣ Getting optimized client for Ethereum (Chain ID: 1)...");
  try {
    const client = await getClient(1);
    const blockNumber = await client.getBlockNumber();
    console.log(`✅ Successfully connected! Current block: ${blockNumber}`);
  } catch (error) {
    console.error("❌ Failed to get optimized client:", error);
  }

  // Test 3: Get redundant clients
  console.log("\n3️⃣ Getting redundant clients for BSC (Chain ID: 56)...");
  try {
    const clients = await getRedundantClients(56);
    console.log(`✅ Got ${clients.length} healthy clients for BSC`);
    
    // Test each client
    for (let i = 0; i < clients.length; i++) {
      try {
        const blockNumber = await clients[i].getBlockNumber();
        console.log(`  Client ${i + 1}: Block ${blockNumber}`);
      } catch (error) {
        console.log(`  Client ${i + 1}: Failed`);
      }
    }
  } catch (error) {
    console.error("❌ Failed to get redundant clients:", error);
  }

  // Test 4: Retry mechanism
  console.log("\n4️⃣ Testing retry mechanism with a potentially unstable operation...");
  try {
    let attempts = 0;
    const result = await executeWithRetry(
      1,
      async (client) => {
        attempts++;
        console.log(`  Attempt ${attempts}...`);
        
        // Simulate occasional failure
        if (attempts < 2 && Math.random() < 0.5) {
          throw new Error("Simulated RPC error");
        }
        
        return client.getGasPrice();
      },
      { maxRetries: 3, retryDelay: 500 }
    );
    
    console.log(`✅ Gas price retrieved after ${attempts} attempts: ${result}`);
  } catch (error) {
    console.error("❌ Retry mechanism failed:", error);
  }

  // Test 5: Create retry-wrapped client
  console.log("\n5️⃣ Testing retry-wrapped client...");
  try {
    const retryClient = await createRetryClient(1, { maxRetries: 2 });
    const [block, gasPrice, chainId] = await Promise.all([
      retryClient.getBlockNumber(),
      retryClient.getGasPrice(),
      retryClient.getChainId(),
    ]);
    
    console.log(`✅ Retry client works!`);
    console.log(`  Block: ${block}`);
    console.log(`  Gas Price: ${gasPrice}`);
    console.log(`  Chain ID: ${chainId}`);
  } catch (error) {
    console.error("❌ Retry client failed:", error);
  }

  // Test 6: Force refresh endpoints
  console.log("\n6️⃣ Testing endpoint refresh...");
  try {
    await refreshRpcEndpoints(1);
    console.log("✅ Endpoints refreshed successfully");
    
    // Get client again to verify refresh worked
    const client = await getClient(1);
    const blockNumber = await client.getBlockNumber();
    console.log(`  Verified with block: ${blockNumber}`);
  } catch (error) {
    console.error("❌ Failed to refresh endpoints:", error);
  }

  console.log("\n✨ RPC connection tests completed!");
}

// Run the tests
if (require.main === module) {
  testRpcConnections()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Test failed:", error);
      process.exit(1);
    });
}