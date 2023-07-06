const express = require('express');
const XLSX = require('xlsx');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
const port = 3000;

app.get('/reconciliation', (req, res) => {
  // Load the first CSV file
  const data1 = [];
  fs.createReadStream('CF.csv')
    .pipe(csv())
    .on('data', (row) => {
      data1.push(row);
    })
    .on('end', () => {
      // Process the data after reading the CSV file
      processFiles(data1, 'CFGT.csv', (reconciledWorkbook) => {
        // Save the reconciled workbook to a buffer
        const buffer = XLSX.write(reconciledWorkbook, { type: 'buffer' });

        // Set the response headers to serve the workbook as a download
        res.set({
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="ReconciledData.xlsx"'
        });

        // Send the buffer as the response
        res.send(buffer);
      });
    });
});

// Process the CSV files and generate the reconciled data and summary
function processFiles(data1, CFGT, callback) {
  const data2 = [];
  fs.createReadStream(CFGT)
    .pipe(csv())
    .on('data', (row) => {
      data2.push(row);
    })
    .on('end', () => {
      // Create a map of order IDs to statuses and amounts from both CSV files
      const orderDataMap = {};

      data1.forEach((row) => {
        if (row.STATUS === 'Failure') {
          row.STATUS = 'FAILED';
        }
      });

      data2.forEach((row) => {
        if (row.STATUS === 'Failure') {
          row.STATUS = 'FAILED';
        }
      });

      data1.forEach((row) => {
        const orderID = String(row.TRANSACTION_ID).trim();
        const AMOUNT = typeof row.AMOUNT === 'number'
          ? row.AMOUNT
          : row.AMOUNT
            ? parseFloat(row.AMOUNT.replace(/,/g, ''))
            : 0;
        if (!orderDataMap[orderID]) {
          orderDataMap[orderID] = { status1: row.STATUS, status2: null, amount1: AMOUNT, amount2: null };
        } else {
          orderDataMap[orderID].amount1 += AMOUNT;
        }
      });

      data2.forEach((row) => {
        const orderID = String(row.TRANSACTION_ID).trim();
        const AMOUNT = typeof row.AMOUNT === 'number'
          ? row.AMOUNT
          : row.AMOUNT
            ? parseFloat(row.AMOUNT.replace(/,/g, ''))
            : 0;
        if (!orderDataMap[orderID]) {
          orderDataMap[orderID] = { status1: null, status2: row.STATUS, amount1: null, amount2: AMOUNT };
        } else {
          orderDataMap[orderID].status2 = row.STATUS;
          orderDataMap[orderID].amount2 += AMOUNT;
        }
      });

      // Reconcile the order statuses and amounts between CF and CFGT
      const reconciledData = [];
      Object.keys(orderDataMap).forEach((orderID) => {
        const { status1, status2, amount1, amount2 } = orderDataMap[orderID];
        const row = { TRANSACTION_ID: orderID };

        if (status1 && status2 && status1 === status2) {
          row.reconciliation_reason = 'Matched';
          row.status1 = status1;
          row.status2 = status2;
          row.amount1 = amount1 || '';
          row.amount2 = amount2 || '';
        } else if (status1 && status2) {
          row.reconciliation_reason = 'Status Mismatch';
          row.status1 = status1;
          row.status2 = status2;
          row.amount1 = amount1 || '';
          row.amount2 = amount2 || '';
        } else if (status1) {
          row.reconciliation_reason = 'Order ID not found in CFGT';
          row.status1 = status1;
          row.status2 = '';
          row.amount1 = amount1 || '';
          row.amount2 = '';
        } else {
          row.reconciliation_reason = 'Order ID not found in CF';
          row.status1 = '';
          row.status2 = status2;
          row.amount1 = '';
          row.amount2 = amount2 || '';
        }

        reconciledData.push(row);
      });

      // Create a new workbook and worksheet to store the reconciled data
      const reconciledWorkbook = XLSX.utils.book_new();
      const reconciledWorksheet = XLSX.utils.json_to_sheet(reconciledData);

      // Add the reconciled worksheet to the workbook
      XLSX.utils.book_append_sheet(reconciledWorkbook, reconciledWorksheet, 'Reconciliation');

      // Generate the summary
      const summaryFile1 = {};
      const summaryFile2 = {};

      reconciledData.forEach((row) => {
        const reconciliationReason = row.reconciliation_reason;
        const status1 = row.status1;
        const status2 = row.status2;
        const amount1 = row.amount1 || 0;
        const amount2 = row.amount2 || 0;

        // Update summaryFile1
        if (!summaryFile1[reconciliationReason]) {
          summaryFile1[reconciliationReason] = { total: 0 };
        }

        if (!summaryFile1[reconciliationReason][status1]) {
          summaryFile1[reconciliationReason][status1] = { count: 0, amount: 0 };
        }

        summaryFile1[reconciliationReason][status1].count++;
        summaryFile1[reconciliationReason][status1].amount += amount1;
        summaryFile1[reconciliationReason].total++;

        // Update summaryFile2
        if (!summaryFile2[reconciliationReason]) {
          summaryFile2[reconciliationReason] = { total: 0 };
        }

        if (!summaryFile2[reconciliationReason][status2]) {
          summaryFile2[reconciliationReason][status2] = { count: 0, amount: 0 };
        }

        summaryFile2[reconciliationReason][status2].count++;
        summaryFile2[reconciliationReason][status2].amount += amount2;
        summaryFile2[reconciliationReason].total++;
      });

      // Create a summary sheet
      const summarySheet = XLSX.utils.aoa_to_sheet([
        ['Summary'],
        [],
        ['Reconciliation Reason', 'Status', 'Count', 'Amount']
      ]);

      let rowIndex = 4;

      // Populate summarySheet with data from summaryFile1
      Object.keys(summaryFile1).forEach((reconciliationReason) => {
        const row = [reconciliationReason, '', summaryFile1[reconciliationReason].total, ''];

        XLSX.utils.sheet_add_aoa(summarySheet, [row], { origin: -1, skipHeader: true });

        rowIndex++;

        Object.keys(summaryFile1[reconciliationReason]).forEach((status) => {
          if (status !== 'total') {
            const count = summaryFile1[reconciliationReason][status].count;
            const amount = summaryFile1[reconciliationReason][status].amount;

            XLSX.utils.sheet_add_aoa(summarySheet, [[, status, count, amount]], {
              origin: -1,
              skipHeader: true
            });

            rowIndex++;
          }
        });
      });

      // Add an empty row before adding summaryFile2 data
      XLSX.utils.sheet_add_aoa(summarySheet, [[]], { origin: -1, skipHeader: true });
      rowIndex++;

      // Populate summarySheet with data from summaryFile2
      Object.keys(summaryFile2).forEach((reconciliationReason) => {
        const row = [reconciliationReason, '', summaryFile2[reconciliationReason].total, ''];

        XLSX.utils.sheet_add_aoa(summarySheet, [row], { origin: -1, skipHeader: true });

        rowIndex++;

        Object.keys(summaryFile2[reconciliationReason]).forEach((status) => {
          if (status !== 'total') {
            const count = summaryFile2[reconciliationReason][status].count;
            const amount = summaryFile2[reconciliationReason][status].amount;

            XLSX.utils.sheet_add_aoa(summarySheet, [[, status, count, amount]], {
              origin: -1,
              skipHeader: true
            });

            rowIndex++;
          }
        });
      });

      // Add the summary sheet to the workbook
      XLSX.utils.book_append_sheet(reconciledWorkbook, summarySheet, 'Summary');

      // Execute the callback function with the reconciled workbook
      callback(reconciledWorkbook);
    });
}

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

app.get('/', (req, res) => {
    res.send('Hello, world!');
  });