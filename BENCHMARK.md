| page_kb | workload | contender | mean_ms | hz | rank | vs_plain_x | rme_pct | samples |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | bulk_insert_1000 | plain-nodefs - bulk insert 1000 rows | 6.6397 | 150.61 | 1 | 1.000 | 3.00 | 76 |
| 4 | bulk_insert_1000 | encrypted - bulk insert 1000 rows | 14.0321 | 71.26 | 2 | 2.113 | 7.96 | 36 |
| 4 | bulk_insert_1000 | cryptograft[unkeyed p=4k chunk=8192] - bulk insert 1000 rows | 17.3634 | 57.59 | 3 | 2.615 | 13.83 | 29 |
| 4 | bulk_insert_1000 | cryptograft[keyed p=4k chunk=8192] - bulk insert 1000 rows | 28.3771 | 35.24 | 4 | 4.274 | 17.68 | 19 |
| 4 | select_1000 | plain-nodefs - select 1000 rows | 0.9299 | 1075.42 | 3 | 1.000 | 1.51 | 538 |
| 4 | select_1000 | encrypted - select 1000 rows | 0.8892 | 1124.56 | 2 | 0.956 | 0.63 | 563 |
| 4 | select_1000 | cryptograft[unkeyed p=4k chunk=8192] - select 1000 rows | 0.8672 | 1153.19 | 1 | 0.933 | 0.57 | 577 |
| 4 | select_1000 | cryptograft[keyed p=4k chunk=8192] - select 1000 rows | 1.1141 | 897.59 | 4 | 1.198 | 2.73 | 449 |
| 8 | bulk_insert_1000 | plain-nodefs - bulk insert 1000 rows | 6.2610 | 159.72 | 1 | 1.000 | 2.39 | 80 |
| 8 | bulk_insert_1000 | encrypted - bulk insert 1000 rows | 10.5285 | 94.98 | 2 | 1.682 | 4.47 | 48 |
| 8 | bulk_insert_1000 | cryptograft[unkeyed p=8k chunk=8192] - bulk insert 1000 rows | 15.6459 | 63.91 | 3 | 2.499 | 11.63 | 32 |
| 8 | bulk_insert_1000 | cryptograft[keyed p=8k chunk=8192] - bulk insert 1000 rows | 34.4757 | 29.01 | 4 | 5.506 | 17.91 | 15 |
| 8 | select_1000 | plain-nodefs - select 1000 rows | 0.9457 | 1057.43 | 3 | 1.000 | 1.11 | 529 |
| 8 | select_1000 | encrypted - select 1000 rows | 0.8997 | 1111.44 | 2 | 0.951 | 0.66 | 556 |
| 8 | select_1000 | cryptograft[unkeyed p=8k chunk=8192] - select 1000 rows | 0.8595 | 1163.43 | 1 | 0.909 | 0.37 | 582 |
| 8 | select_1000 | cryptograft[keyed p=8k chunk=8192] - select 1000 rows | 1.2555 | 796.52 | 4 | 1.328 | 34.32 | 399 |
| 16 | bulk_insert_1000 | plain-nodefs - bulk insert 1000 rows | 6.1083 | 163.71 | 1 | 1.000 | 1.91 | 82 |
| 16 | bulk_insert_1000 | encrypted - bulk insert 1000 rows | 10.1830 | 98.20 | 2 | 1.667 | 4.97 | 50 |
| 16 | bulk_insert_1000 | cryptograft[unkeyed p=16k chunk=8192] - bulk insert 1000 rows | 16.2326 | 61.60 | 3 | 2.657 | 11.39 | 31 |
| 16 | bulk_insert_1000 | cryptograft[keyed p=16k chunk=8192] - bulk insert 1000 rows | 53.5400 | 18.68 | 4 | 8.765 | 23.73 | 10 |
| 16 | select_1000 | plain-nodefs - select 1000 rows | 0.9545 | 1047.67 | 1 | 1.000 | 1.12 | 524 |
| 16 | select_1000 | encrypted - select 1000 rows | 1.1657 | 857.82 | 4 | 1.221 | 50.48 | 429 |
| 16 | select_1000 | cryptograft[unkeyed p=16k chunk=8192] - select 1000 rows | 0.9883 | 1011.85 | 2 | 1.035 | 1.53 | 506 |
| 16 | select_1000 | cryptograft[keyed p=16k chunk=8192] - select 1000 rows | 1.0399 | 961.67 | 3 | 1.089 | 0.83 | 481 |
| 32 | bulk_insert_1000 | plain-nodefs - bulk insert 1000 rows | 6.2186 | 160.81 | 1 | 1.000 | 2.14 | 81 |
| 32 | bulk_insert_1000 | encrypted - bulk insert 1000 rows | 10.3804 | 96.34 | 2 | 1.669 | 5.36 | 49 |
| 32 | bulk_insert_1000 | cryptograft[unkeyed p=32k chunk=8192] - bulk insert 1000 rows | 16.9366 | 59.04 | 3 | 2.724 | 13.97 | 30 |
| 32 | bulk_insert_1000 | cryptograft[keyed p=32k chunk=8192] - bulk insert 1000 rows | 81.4737 | 12.27 | 4 | 13.102 | 22.22 | 10 |
| 32 | select_1000 | plain-nodefs - select 1000 rows | 0.9791 | 1021.36 | 3 | 1.000 | 9.67 | 511 |
| 32 | select_1000 | encrypted - select 1000 rows | 0.9574 | 1044.50 | 2 | 0.978 | 9.45 | 523 |
| 32 | select_1000 | cryptograft[unkeyed p=32k chunk=8192] - select 1000 rows | 0.8544 | 1170.38 | 1 | 0.873 | 0.37 | 586 |
| 32 | select_1000 | cryptograft[keyed p=32k chunk=8192] - select 1000 rows | 1.4670 | 681.66 | 4 | 1.498 | 40.18 | 341 |
| 64 | bulk_insert_1000 | plain-nodefs - bulk insert 1000 rows | 6.2143 | 160.92 | 1 | 1.000 | 2.28 | 81 |
| 64 | bulk_insert_1000 | encrypted - bulk insert 1000 rows | 10.8814 | 91.90 | 2 | 1.751 | 5.54 | 47 |
| 64 | bulk_insert_1000 | cryptograft[unkeyed p=64k chunk=8192] - bulk insert 1000 rows | 18.7260 | 53.40 | 3 | 3.013 | 15.42 | 27 |
| 64 | bulk_insert_1000 | cryptograft[keyed p=64k chunk=8192] - bulk insert 1000 rows | 146.2136 | 6.84 | 4 | 23.528 | 23.71 | 10 |
| 64 | select_1000 | plain-nodefs - select 1000 rows | 1.0674 | 936.81 | 2 | 1.000 | 2.48 | 469 |
| 64 | select_1000 | encrypted - select 1000 rows | 0.9374 | 1066.83 | 1 | 0.878 | 2.64 | 534 |
| 64 | select_1000 | cryptograft[unkeyed p=64k chunk=8192] - select 1000 rows | 1.0691 | 935.34 | 3 | 1.002 | 33.98 | 468 |
| 64 | select_1000 | cryptograft[keyed p=64k chunk=8192] - select 1000 rows | 1.6747 | 597.11 | 4 | 1.569 | 2.02 | 301 |
