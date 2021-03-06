/* eslint no-await-in-loop: off */

const axios = require('axios');
const BigNumber = require('bignumber.js');

const publisher = require('./util/gcloudPub');
const config = require('./config/config.js');
const { web3, STATUS, getTransactionStatus } = require('./util/web3.js');
const { db } = require('./util/db.js');

const PUBSUB_TOPIC_MISC = 'misc';

const ONE_LIKE = new BigNumber(10).pow(18);

const TIME_LIMIT = config.TIME_LIMIT || 60 * 60 * 1000 * 24; // fallback: 1 day
const TX_LOOP_INTERVAL = config.TX_LOOP_INTERVAL || 30 * 1000; // fallback: 30s
const TIME_BEFORE_FIRST_ENQUEUE = config.TIME_BEFORE_FIRST_ENQUEUE || 60 * 1000; // fallback: 60s

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class PollTxMonitor {
  constructor(doc, rateLimiter) {
    this.txHash = doc.id;
    this.data = doc.data();
    this.ts = Number.parseInt(this.data.ts, 10) || Date.now();
    this.rateLimiter = rateLimiter;
    this.shouldStop = false;
  }

  async writeTxStatus(receipt, networkTx) {
    const statusUpdate = { status: this.status };
    let blockNumber = 0;
    let blockTime = 0;
    let fromReferrer;
    let fromDisplayName;
    let fromEmail;
    let toDisplayName;
    let toEmail;
    let toReferrer;
    let toSubscriptionURL;

    const {
      nonce,
      type,
      delegatorAddress,
    } = this.data;
    let {
      fromId,
      toId,
      value,
      from,
      to,
    } = this.data;

    if (networkTx && type === 'transferETH') {
      ({ from, to, value } = networkTx);
      statusUpdate.from = from;
      statusUpdate.to = to;
      statusUpdate.value = value;
    }

    try {
      const fromQuery = db.collection(config.FIRESTORE_USER_ROOT).where('wallet', '==', from).get().then((snapshot) => {
        if (snapshot.docs.length > 0) {
          const fromUser = snapshot.docs[0].data();
          return {
            fromId: snapshot.docs[0].id,
            fromDisplayName: fromUser.displayName,
            fromEmail: fromUser.email,
            fromReferrer: fromUser.referrer,
          };
        }
        return {};
      });
      const toQuery = db.collection(config.FIRESTORE_USER_ROOT).where('wallet', '==', to).get().then((snapshot) => {
        if (snapshot.docs.length > 0) {
          const toUser = snapshot.docs[0].data();
          return {
            toId: snapshot.docs[0].id,
            toDisplayName: toUser.displayName,
            toEmail: toUser.email,
            toReferrer: toUser.referrer,
            toSubscriptionURL: toUser.subscriptionURL,
          };
        }
        return {};
      });
      [{
        fromId,
        fromDisplayName,
        fromEmail,
        fromReferrer,
      }, {
        toId,
        toDisplayName,
        toEmail,
        toReferrer,
        toSubscriptionURL,
      },
      ] = await Promise.all([fromQuery, toQuery]);
    } catch (err) {
      console.error(err);
    }

    if (receipt) {
      ({ blockNumber } = receipt);
      statusUpdate.completeBlockNumber = blockNumber;
      blockTime = (await web3.eth.getBlock(blockNumber)).timestamp * 1000; // convert seconds to ms
      statusUpdate.completeTs = blockTime;
    }
    db.collection(config.FIRESTORE_TX_ROOT).doc(this.txHash).update(statusUpdate);
    let likeAmount;
    let likeAmountUnitStr;
    let ETHAmount;
    let ETHAmountUnitStr;
    if (value !== undefined) {
      switch (type) {
        case 'transferETH':
          ETHAmount = new BigNumber(value).dividedBy(ONE_LIKE).toNumber();
          ETHAmountUnitStr = new BigNumber(value).toFixed();
          break;
        default:
          likeAmount = new BigNumber(value).dividedBy(ONE_LIKE).toNumber();
          likeAmountUnitStr = new BigNumber(value).toFixed();
          break;
      }
    }
    publisher.publish(PUBSUB_TOPIC_MISC, {
      logType: 'eventStatus',
      txHash: this.txHash,
      txStatus: this.status,
      txBlock: receipt ? receipt.blockHash : '',
      txBlockNumber: blockNumber,
      txBlockTime: blockTime,
      txGasUsed: receipt ? receipt.gasUsed : 0,
      txNonce: nonce,
      txType: type,
      fromUser: fromId,
      fromWallet: from,
      fromDisplayName,
      fromEmail,
      fromReferrer,
      toUser: toId,
      toWallet: to,
      toDisplayName,
      toEmail,
      toReferrer,
      likeAmount,
      likeAmountUnitStr,
      ETHAmount,
      ETHAmountUnitStr,
      delegatorAddress,
    });
    if (toSubscriptionURL) {
      try {
        await axios.post(toSubscriptionURL, {
          completeTs: blockTime,
          from,
          status: this.status,
          to,
          ts: this.ts,
          txHash: this.txHash,
          type,
          value,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(this.txHash, 'Error when posting to subscriptionURL:', error);
      }
    }
  }

  async startLoop() {
    try {
      const startDelay = (this.ts + TIME_BEFORE_FIRST_ENQUEUE) - Date.now();
      if (startDelay > 0) {
        await sleep(startDelay);
      }
      let finished = false;
      while (!this.shouldStop) {
        const { status, receipt, networkTx } = await this.rateLimiter.schedule(
          getTransactionStatus,
          this.txHash,
          { requireReceipt: true },
        );
        this.status = status;
        switch (status) {
          case STATUS.SUCCESS:
          case STATUS.FAIL:
            try {
              await this.writeTxStatus(receipt, networkTx);
              finished = true;
            } catch (err) {
              console.error(this.txHash, `Error when writing tx status (${this.status}):`, err); // eslint-disable-line no-console
            }
            break;
          case STATUS.MINED:
            this.ts = Date.now();
            break;
          case STATUS.PENDING:
            break;
          case STATUS.NOT_FOUND:
            if (Date.now() - this.ts > TIME_LIMIT) {
              // timeout
              this.status = STATUS.TIMEOUT;
              try {
                await this.writeTxStatus();
                finished = true;
              } catch (err) {
                console.error(this.txHash, `Error when writing tx status (${this.status}):`, err); // eslint-disable-line no-console
              }
            }
            break;
          default:
        }
        if (finished) {
          break;
        }
        await sleep(TX_LOOP_INTERVAL);
      }
    } catch (err) {
      console.error(this.txHash, 'Error in PollTxMonitor loop:', err); // eslint-disable-line no-console
    }
    if (this.onFinish) {
      this.onFinish(this);
    }
  }

  stop() {
    this.shouldStop = true;
  }
}

module.exports = PollTxMonitor;
