import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import '../stores/vendor_store.dart';
import '../theme.dart';

class Product {
  final String id;
  final String name;
  final double price;
  final bool isNegotiable;
  final double minPrice;
  final String? imageUrl;

  Product({
    required this.id,
    required this.name,
    required this.price,
    required this.isNegotiable,
    required this.minPrice,
    this.imageUrl,
  });

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['_id']?.toString() ?? json['id']?.toString() ?? '',
      name: json['name'] ?? '',
      price: (json['price'] ?? 0).toDouble(),
      isNegotiable: json['isNegotiable'] == true,
      minPrice: (json['minPrice'] ?? json['price'] ?? 0).toDouble(),
      imageUrl: json['imageUrl'],
    );
  }
}

class ProductsTab extends StatefulWidget {
  const ProductsTab({super.key});

  @override
  State<ProductsTab> createState() => _ProductsTabState();
}

class _ProductsTabState extends State<ProductsTab> {
  List<Product> _products = [];
  bool _isLoading = false;
  final List<String> _deletingIds = [];
  final NumberFormat _currencyFormat = NumberFormat.currency(locale: 'en_NG', symbol: '₦', decimalDigits: 0);

  // Add Product Form Controllers
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _priceController = TextEditingController();
  final TextEditingController _minPriceController = TextEditingController();
  final TextEditingController _imageController = TextEditingController();
  bool _isNegotiable = false;

  @override
  void initState() {
    super.initState();
    _fetchProducts();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _priceController.dispose();
    _minPriceController.dispose();
    _imageController.dispose();
    super.dispose();
  }

  Future<void> _fetchProducts() async {
    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _isLoading = true;
    });

    try {
      final response = await http.get(
        Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/products'),
        headers: store.token != null ? {'Authorization': 'Bearer ${store.token}'} : null,
      );

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        setState(() {
          _products = data.map((json) => Product.fromJson(json)).toList();
        });
      } else {
        throw Exception('Server error');
      }
    } catch (e) {
      debugPrint('Error fetching products, utilizing mock fallbacks: $e');
      final mockProducts = [
        Product(
          id: '1',
          name: 'Vintage Shirt',
          price: 12000.0,
          isNegotiable: true,
          minPrice: 10000.0,
          imageUrl: 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=200',
        ),
        Product(
          id: '2',
          name: 'Designer Sneakers',
          price: 28000.0,
          isNegotiable: false,
          minPrice: 28000.0,
          imageUrl: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=200',
        ),
        Product(
          id: '3',
          name: 'Leather Handbag',
          price: 18500.0,
          isNegotiable: true,
          minPrice: 16000.0,
          imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=200',
        ),
      ];
      setState(() {
        _products = mockProducts;
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _handleDeleteProduct(String id) async {
    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _deletingIds.add(id);
    });

    try {
      final response = await http.delete(
        Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/products/$id'),
        headers: store.token != null ? {'Authorization': 'Bearer ${store.token}'} : null,
      );

      if (response.statusCode == 200) {
        _fetchProducts();
      } else {
        throw Exception('Server rejected delete');
      }
    } catch (e) {
      debugPrint('API product delete failed, deleting locally: $e');
      setState(() {
        _products.removeWhere((p) => p.id == id);
      });
    } finally {
      setState(() {
        _deletingIds.remove(id);
      });
    }
  }

  Future<void> _handleAddProduct() async {
    final name = _nameController.text.trim();
    final priceStr = _priceController.text.trim();
    final minPriceStr = _minPriceController.text.trim();
    final imageUrl = _imageController.text.trim();

    if (name.isEmpty || priceStr.isEmpty) return;

    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _isLoading = true;
    });

    final double price = double.parse(priceStr);
    final double minPrice = minPriceStr.isNotEmpty ? double.parse(minPriceStr) : price;

    try {
      // In Flutter we make a MultipartRequest for file uploads if local files are selected.
      // But since we input URL, we can send a JSON payload or standard multipart.
      // The React Native app used FormData for files. If url is supplied, we serialize it.
      final uri = Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/products');
      final request = http.MultipartRequest('POST', uri);
      if (store.token != null) {
        request.headers['Authorization'] = 'Bearer ${store.token}';
      }
      
      request.fields['name'] = name;
      request.fields['price'] = priceStr;
      request.fields['isNegotiable'] = _isNegotiable.toString();
      request.fields['minPrice'] = minPrice.toString();
      
      if (imageUrl.isNotEmpty) {
        request.fields['imageUrl'] = imageUrl;
      }

      final response = await request.send();
      if (response.statusCode == 200 || response.statusCode == 201) {
        Navigator.of(context).pop();
        _clearForm();
        _fetchProducts();
      } else {
        throw Exception('Server rejected request');
      }
    } catch (e) {
      debugPrint('API add product failed, adding locally (mock mode): $e');
      final mockNew = Product(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        name: name,
        price: price,
        isNegotiable: _isNegotiable,
        minPrice: minPrice,
        imageUrl: imageUrl.isNotEmpty ? imageUrl : 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=200',
      );
      setState(() {
        _products.add(mockNew);
      });
      Navigator.of(context).pop();
      _clearForm();
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _clearForm() {
    _nameController.clear();
    _priceController.clear();
    _minPriceController.clear();
    _imageController.clear();
    setState(() {
      _isNegotiable = false;
    });
  }

  void _showAddProductDialog() {
    _clearForm();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.of(context).viewInsets.bottom,
                top: 20,
                left: 16,
                right: 16,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Add New Product',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _nameController,
                      decoration: const InputDecoration(labelText: 'Product Name'),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _priceController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(labelText: 'Price (₦)'),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Allow AI Negotiation',
                          style: TextStyle(color: AppTheme.secondaryDark, fontSize: 14),
                        ),
                        Switch(
                          value: _isNegotiable,
                          activeColor: AppTheme.primaryGreen,
                          onChanged: (val) {
                            setModalState(() {
                              _isNegotiable = val;
                            });
                          },
                        ),
                      ],
                    ),
                    if (_isNegotiable) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: _minPriceController,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(labelText: 'Minimum Acceptable Price (₦)'),
                      ),
                    ],
                    const SizedBox(height: 16),
                    TextField(
                      controller: _imageController,
                      decoration: const InputDecoration(
                        labelText: 'Image URL (optional)',
                        hintText: 'https://...',
                      ),
                    ),
                    const SizedBox(height: 24),
                    ElevatedButton(
                      onPressed: _isLoading ? null : _handleAddProduct,
                      child: _isLoading
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                            )
                          : const Text('Save Product'),
                    ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _fetchProducts,
        color: AppTheme.primaryGreen,
        child: _isLoading && _products.isEmpty
            ? const Center(child: CircularProgressIndicator(color: AppTheme.primaryGreen))
            : _products.isEmpty
                ? _buildEmptyState()
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _products.length,
                    itemBuilder: (context, index) {
                      final item = _products[index];
                      return _buildProductCard(item);
                    },
                  ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showAddProductDialog,
        backgroundColor: AppTheme.primaryGreen,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('Add Product'),
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(32.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.inventory_2_outlined, size: 64, color: Colors.grey.shade300),
            const SizedBox(height: 16),
            const Text(
              'No products added yet.',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
            ),
            const SizedBox(height: 8),
            const Text(
              'Add products to your catalog to let customers query and purchase them.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: AppTheme.textMuted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProductCard(Product item) {
    final isDeleting = _deletingIds.contains(item.id);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12.0),
        child: Row(
          children: [
            // Left: image thumbnail
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: item.imageUrl != null && item.imageUrl!.startsWith('http')
                  ? Image.network(
                      item.imageUrl!,
                      width: 60,
                      height: 60,
                      fit: BoxFit.cover,
                      errorBuilder: (context, error, stackTrace) => _buildPlaceholderImage(),
                    )
                  : _buildPlaceholderImage(),
            ),
            const SizedBox(width: 14),

            // Middle: Name, Price, negotiation tag
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.name,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                      color: AppTheme.secondaryDark,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _currencyFormat.format(item.price),
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                      color: Colors.grey.shade700,
                    ),
                  ),
                  if (item.isNegotiable) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Negotiable (Min: ${_currencyFormat.format(item.minPrice)})',
                      style: const TextStyle(
                        fontSize: 11,
                        color: AppTheme.whatsappGreen,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ],
              ),
            ),

            // Right: Delete button
            IconButton(
              icon: isDeleting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(color: AppTheme.dangerRed, strokeWidth: 2),
                    )
                  : const Icon(Icons.delete, color: AppTheme.dangerRed, size: 22),
              onPressed: isDeleting ? null : () => _handleDeleteProduct(item.id),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlaceholderImage() {
    return Container(
      width: 60,
      height: 60,
      color: AppTheme.primaryGreen.withOpacity(0.1),
      child: const Icon(Icons.image_outlined, color: AppTheme.primaryGreen, size: 28),
    );
  }
}
